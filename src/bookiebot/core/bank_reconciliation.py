from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
import logging
import os
from collections.abc import AsyncIterator, Callable
from typing import Any, AsyncContextManager, Awaitable, cast

import discord

from bookiebot.banking.formatting import format_reconciliation_match_report_chunks, format_reconciliation_review_chunks
from bookiebot.banking.models import ReconciliationItem, ReconciliationPreview, ReconciliationReportMatch
from bookiebot.banking.service import build_banking_service, refresh_reconciliation_review
from bookiebot.core.bank_reconciliation_flow import send_next_bank_reconciliation_item
from bookiebot.core.bank_link import bank_reconnect_url
from bookiebot.sheets.routing import (
    APPLE_SHORTCUT_RELAY_USER_ID,
    get_discord_user_config,
    get_user_config,
    now_pacific,
    PACIFIC_TZ,
)
from bookiebot.sheets.undo import has_system_event, record_system_event, read_logged_action_history
from bookiebot.ui.bank_reconciliation import (
    BankReconciliationDigestView,
    BankReconciliationInboxView,
)

logger = logging.getLogger(__name__)

_BANK_RECONCILIATION_TASK: asyncio.Task | None = None
_BANK_RECONCILIATION_WAKE: asyncio.Event | None = None
_PERSISTENT_DIGEST_VIEW_REGISTERED = False
_INBOX_MATCH_DETAILS_TIMEOUT_SECONDS = 5.0


@dataclass(frozen=True)
class PreparedBankReconciliationDigest:
    public_message: str
    detail_message: str
    detail_messages: tuple[str, ...] = ()
    report_matches: tuple[ReconciliationReportMatch, ...] = ()
    item_ids: tuple[int, ...] = ()
    owner_key: str = ""
    owner_name: str = ""
    reviewed_items: tuple[ReconciliationItem, ...] = ()
    preview: ReconciliationPreview | None = None
    event_type: str = 'bank_reconciliation_digest_sent'
    reconnect_links: tuple[tuple[str, str], ...] = ()


def _bank_reconciliation_enabled() -> bool:
    return os.getenv("BOOKIEBOT_BANK_RECONCILIATION_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _check_interval_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_INTERVAL_SECONDS", "3600").strip()
    try:
        return max(int(raw), 60)
    except ValueError:
        return 3600


def _send_hour() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR", "10").strip()
    try:
        return min(max(int(raw), 0), 23)
    except ValueError:
        return 10


def _send_window_minutes() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES", "60").strip()
    try:
        return max(int(raw), 1)
    except ValueError:
        return 60


def _inbox_load_timeout_seconds() -> float:
    raw = os.getenv("BOOKIEBOT_RECONCILIATION_INBOX_TIMEOUT_SECONDS", "15").strip()
    try:
        return min(max(float(raw), 1.0), 120.0)
    except ValueError:
        return 15.0


@asynccontextmanager
async def _interaction_typing(interaction: Any) -> AsyncIterator[None]:
    channel = getattr(interaction, "channel", None)
    typing = getattr(channel, "typing", None)
    if not callable(typing):
        yield
        return

    typing_context = cast(AsyncContextManager[Any], typing())
    try:
        await typing_context.__aenter__()
    except Exception as exc:
        logger.warning(
            "Discord interaction typing indicator unavailable; continuing without it",
            extra={"exception": str(exc)},
        )
        yield
        return

    try:
        yield
    except BaseException as body_error:
        try:
            suppress = await typing_context.__aexit__(
                type(body_error),
                body_error,
                body_error.__traceback__,
            )
        except Exception as exc:
            logger.warning(
                "Discord interaction typing indicator cleanup failed",
                extra={"exception": str(exc)},
            )
            suppress = False
        if not suppress:
            raise
    else:
        try:
            await typing_context.__aexit__(None, None, None)
        except Exception as exc:
            logger.warning(
                "Discord interaction typing indicator cleanup failed; request completed normally",
                extra={"exception": str(exc)},
            )


def _is_eligible(now: datetime | None = None) -> bool:
    current = now or now_pacific()
    window_start = current.replace(hour=_send_hour(), minute=0, second=0, microsecond=0)
    window_end = window_start + timedelta(minutes=_send_window_minutes())
    return window_start <= current < window_end


def _notification_users() -> list[tuple[str, str]]:
    seen_owner_keys: set[str] = set()
    users: list[tuple[str, str]] = []
    for actor_key, user_config in get_discord_user_config().items():
        if actor_key == APPLE_SHORTCUT_RELAY_USER_ID or actor_key.startswith("shortcut:"):
            continue
        if not actor_key.isdigit():
            continue
        if user_config.budget_owner_key in seen_owner_keys:
            continue
        seen_owner_keys.add(user_config.budget_owner_key)
        users.append((actor_key, f"<@{actor_key}>"))
    return users


def _target_channel(client: Any) -> Any | None:
    channel_id = os.getenv("CHANNEL_ID", "").strip()
    if channel_id:
        try:
            channel = client.get_channel(int(channel_id))
        except ValueError:
            channel = None
        if channel is not None:
            return channel

    channel_name = os.getenv("CHANNEL_NAME", "babys-books").strip()
    for guild in getattr(client, "guilds", []) or []:
        for channel in getattr(guild, "text_channels", []) or []:
            if getattr(channel, "name", None) == channel_name:
                return channel
    return None


async def _target_user(client: Any, actor_key: str) -> Any | None:
    try:
        user_id = int(actor_key)
    except (TypeError, ValueError):
        return None
    get_user = getattr(client, "get_user", None)
    if callable(get_user):
        user = get_user(user_id)
        if user is not None:
            return user
    fetch_user = getattr(client, "fetch_user", None)
    if callable(fetch_user):
        async_fetch_user = cast(Callable[[int], Awaitable[Any]], fetch_user)
        return await async_fetch_user(user_id)
    return None


async def _send_user_dm(client: Any, actor_key: str, content: str, **kwargs: Any) -> bool:
    user = await _target_user(client, actor_key)
    send = getattr(user, "send", None)
    if not callable(send):
        return False
    try:
        async_send = cast(Callable[..., Awaitable[Any]], send)
        await async_send(content, **kwargs)
        return True
    except Exception:
        logger.exception("Failed to send bank reconciliation DM", extra={"actor_key": actor_key})
        return False


def _digest_metadata(current: date) -> dict[str, str]:
    return {"digest_date": current.isoformat()}


def _digest_events(actor_key: str, current: date) -> set[str]:
    # Read the owner-scoped audit once rather than fetch Sheets for every flag.
    return {logged.action.metadata.get('event_type', '') for logged in read_logged_action_history(actor_key)
        if logged.status == 'active' and logged.action.metadata.get('type') == 'system_state'
        and logged.action.metadata.get('digest_date') == current.isoformat()}


async def notify_bank_reconciliation_refreshed(actor_key: str) -> None:
    """Persist one morning refresh request, then wake the single delivery loop."""
    current = now_pacific()
    if not _bank_reconciliation_enabled() or not _is_eligible(current):
        return
    try:
        events = await asyncio.to_thread(_digest_events, actor_key, current.date())
        if 'bank_reconciliation_resync_completed' not in events:
            await asyncio.to_thread(record_system_event, actor_key, 'bank_reconciliation_resync_completed',
                _digest_metadata(current.date()), 'Bank resync and reconciliation refresh completed')
    except Exception:
        logger.exception('Could not record morning bank refresh request', extra={'actor_key': actor_key})
    if _BANK_RECONCILIATION_WAKE is not None:
        _BANK_RECONCILIATION_WAKE.set()


def bank_connection_alert_view(actor_key: str, links: tuple[tuple[str, str], ...] = ()) -> BankReconciliationDigestView:
    view = bank_reconciliation_digest_view(actor_key)
    for child in list(view.children):
        if getattr(child, 'action', '') != 'resync':
            view.remove_item(child)
    for label, url in links[:5]:
        view.add_item(discord.ui.Button(label=label[:80], url=url))
    return view


async def _resync_bank_information(interaction: Any, actor_key: str) -> None:
    owner = get_user_config(actor_key)
    service = build_banking_service()
    try:
        await asyncio.wait_for(service.sync_owner(owner.budget_owner_key), timeout=60)
        await asyncio.wait_for(refresh_reconciliation_review(service, owner.budget_owner_key, actor_key), timeout=60)
    except Exception:
        logger.exception('Bank resync from Discord failed', extra={'actor_key': actor_key})
        issues = await asyncio.to_thread(service.connection_issues, owner.budget_owner_key)
        base_url = (service.config.public_base_url or '').rstrip('/')
        links = tuple((f"Reconnect {issue['institution']}", bank_reconnect_url(
            actor_key, owner.budget_owner_key, issue['id'], base_url))
            for issue in issues if issue['needsReconnect']) if base_url else ()
        await interaction.followup.send('Bank sync could not finish. Use Reconnect below if sign-in is needed, '
            'or try Resync bank again. Saved review history is preserved.', ephemeral=True,
            view=bank_connection_alert_view(actor_key, links))
        return
    await notify_bank_reconciliation_refreshed(actor_key)
    await interaction.followup.send('Bank information and reconciliation refreshed. Open Reconcile in the web app '
        'or View Inbox here. During the 10 AM Pacific morning window, the digest refreshes automatically.',
        ephemeral=True, view=bank_reconciliation_digest_view(actor_key))


async def send_due_bank_reconciliation_digest(client: Any, today: date | None = None) -> int:
    if not _bank_reconciliation_enabled():
        return 0
    current_time = now_pacific()

    fallback_channel = _target_channel(client)

    if today is None and not _is_eligible(current_time):
        return 0

    current = today or current_time.date()
    sent = 0
    for actor_key, mention in _notification_users():
        digest = await asyncio.to_thread(
            prepare_bank_reconciliation_digest_messages,
            actor_key,
            mention,
            current,
            mark_sent=False,
        )
        if not digest:
            continue
        if digest.event_type == 'bank_connection_alert_sent':
            view = bank_connection_alert_view(actor_key, digest.reconnect_links)
        else:
            view = bank_reconciliation_digest_view(actor_key)
        delivered = await _send_user_dm(
            client,
            actor_key,
            f"{digest.public_message}\n\u200b",
            **({'view': view} if view.children else {}),
        )
        if not delivered:
            if fallback_channel is not None:
                await fallback_channel.send(
                    f"{mention} I could not send your private bank reconciliation digest. Please check your DM settings."
                )
            continue
        if not await asyncio.to_thread(
            record_system_event,
            actor_key,
            digest.event_type,
            {**_digest_metadata(current), "sent_after": "discord_dm_send"},
            f"{'Bank connection alert' if digest.event_type == 'bank_connection_alert_sent' else 'Bank reconciliation digest'} sent for {current.isoformat()}",
        ):
            logger.warning(
                "Bank reconciliation digest sent but system event was not recorded",
                extra={"actor_key": actor_key, "digest_date": current.isoformat()},
            )
        sent += 1
    return sent


async def _start_bank_reconciliation_from_prompt(interaction: Any, actor_key: str, *, clear_prompt: bool) -> None:
    if not await _claim_bank_reconciliation_prompt(interaction, actor_key):
        await interaction.followup.send(
            content="This reconciliation prompt has already been used. Run `/debug_bank_review` to inspect the current inbox.",
            ephemeral=True,
        )
        return
    if clear_prompt:
        await _clear_digest_prompt_buttons(interaction)
    owner = get_user_config(actor_key)
    await send_next_bank_reconciliation_item(
        interaction,
        owner_key=owner.budget_owner_key,
        owner_name=owner.name,
        actor_key=actor_key,
    )


async def _with_inbox_match_details(
    digest: PreparedBankReconciliationDigest, actor_key: str,
) -> PreparedBankReconciliationDigest:
    """Optionally resolve saved match details without withholding the persisted inbox."""
    if digest.preview is None or not any(
        match.source_type != "automatic rule" and match.matched_name is None
        for match in digest.report_matches
    ):
        return digest
    matched_items = [item for item in digest.reviewed_items if item.status == "matched"]
    try:
        service = build_banking_service()
        matches = await asyncio.wait_for(
            asyncio.to_thread(
                service.reconciliation_report_matches, digest.owner_key, matched_items,
                actor_key=actor_key, limit=100,
            ),
            timeout=_INBOX_MATCH_DETAILS_TIMEOUT_SECONDS,
        )
    except TimeoutError:
        logger.warning("Inbox sheet details timed out; using persisted match references", extra={"actor_key": actor_key})
        return digest
    except Exception:
        logger.exception("Inbox sheet details unavailable; using persisted match references", extra={"actor_key": actor_key})
        return digest
    unresolved = [item for item in digest.reviewed_items if item.id in digest.item_ids]
    messages = tuple(format_bank_reconciliation_digest_chunks(
        f"<@{actor_key}>", digest.preview, unresolved, report_matches=matches,
    ))
    return replace(digest, report_matches=tuple(matches), detail_messages=messages, detail_message="\n\n".join(messages))


async def _send_bank_reconciliation_inbox(interaction: Any, actor_key: str) -> None:
    try:
        digest = await asyncio.wait_for(
            asyncio.to_thread(
                prepare_bank_reconciliation_inbox_messages,
                actor_key,
                f"<@{actor_key}>",
                now_pacific().date(),
            ),
            timeout=_inbox_load_timeout_seconds(),
        )
    except TimeoutError:
        logger.warning("Bank reconciliation inbox load timed out", extra={"actor_key": actor_key})
        await interaction.followup.send(
            content="I couldn't load the reconciliation inbox in time. Nothing was changed; please try again.",
            ephemeral=True,
        )
        return
    except Exception:
        logger.exception("Failed to load bank reconciliation inbox", extra={"actor_key": actor_key})
        await interaction.followup.send(
            content="I couldn't load the reconciliation inbox right now. Nothing was changed; please try again.",
            ephemeral=True,
        )
        return
    if not digest:
        await interaction.followup.send(
            content="Bank reconciliation is all caught up. No unresolved items remain.",
            ephemeral=True,
        )
        return

    digest = await _with_inbox_match_details(digest, actor_key)

    async def handle_inbox_action(action_interaction: Any, action: str) -> None:
        interaction_actor_key = _interaction_actor_key(action_interaction)
        if interaction_actor_key != str(actor_key):
            await action_interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await action_interaction.response.defer(ephemeral=True, thinking=False)
        async with _interaction_typing(action_interaction):
            if action == "start":
                await _start_bank_reconciliation_from_prompt(action_interaction, actor_key, clear_prompt=False)
                return
            if action == "ignore_all":
                service = build_banking_service()
                ignored_count = 0
                snapshots = {item.id: item for item in digest.reviewed_items}
                for item_id in digest.item_ids:
                    expected = snapshots.get(item_id)
                    if expected is None:
                        continue
                    ignored = await asyncio.to_thread(
                        service.ignore_reconciliation_item, digest.owner_key, item_id, expected_item=expected,
                    )
                    if ignored is not None:
                        ignored_count += 1
                await action_interaction.followup.send(
                    content=f"Ignored `{ignored_count}` bank reconciliation item(s) from this inbox.",
                    ephemeral=True,
                )
                return
            if action.startswith("unmatch:"):
                try:
                    reconciliation_id = int(action.split(":", 1)[1])
                except ValueError:
                    await action_interaction.followup.send(
                        content="That match selection was invalid.",
                        ephemeral=True,
                    )
                    return
                service = build_banking_service()
                expected = next((item for item in digest.reviewed_items if item.id == reconciliation_id), None)
                if expected is None:
                    await action_interaction.followup.send("This inbox changed. Open View Inbox again.", ephemeral=True)
                    return
                reopened = await asyncio.to_thread(
                    service.reopen_reconciliation_item,
                    digest.owner_key,
                    reconciliation_id,
                    notes="unmatched from reconciliation report", expected_item=expected,
                )
                if reopened is None:
                    await action_interaction.followup.send(
                        content="This transaction was already changed in the app or Discord. Open View Inbox to see its current status.",
                        ephemeral=True,
                    )
                    return
                await action_interaction.followup.send(
                    content=(
                        f"Unmatched `{reopened.transaction.name}` for "
                        f"`${abs(reopened.transaction.amount):.2f}`. It is back in the review queue."
                    ),
                    ephemeral=True,
                )

    messages = digest.detail_messages or (digest.detail_message,)
    view_message_index = 0 if digest.item_ids else len(messages) - 1
    for index, message in enumerate(messages):
        view = (
            BankReconciliationInboxView(
                handle_inbox_action,
                has_unresolved=bool(digest.item_ids),
                matches=list(digest.report_matches),
            )
            if index == view_message_index and (digest.item_ids or digest.report_matches)
            else None
        )
        # Webhook.send rejects view=None; omit it on pages without controls.
        view_kwargs = {"view": view} if view is not None else {}
        await interaction.followup.send(
            content=message,
            ephemeral=True,
            **view_kwargs,
        )


def bank_reconciliation_digest_view(actor_key: str) -> BankReconciliationDigestView:
    async def handle_action(interaction: Any, action: str) -> None:
        interaction_actor_key = _interaction_actor_key(interaction)
        if interaction_actor_key != str(actor_key):
            await interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=False)
        async with _interaction_typing(interaction):
            if action == "start":
                await _start_bank_reconciliation_from_prompt(interaction, actor_key, clear_prompt=True)
                return
            if action == "inbox":
                await _send_bank_reconciliation_inbox(interaction, actor_key)
            if action == 'resync':
                await _resync_bank_information(interaction, actor_key)

    return BankReconciliationDigestView(handle_action, actor_key=str(actor_key))


def persistent_bank_reconciliation_digest_view(actor_key: str) -> BankReconciliationDigestView:
    async def handle_action(interaction: Any, action: str) -> None:
        interaction_actor_key = _interaction_actor_key(interaction)
        if interaction_actor_key != str(actor_key):
            await interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=False)
        async with _interaction_typing(interaction):
            if action == "start":
                await _start_bank_reconciliation_from_prompt(interaction, actor_key, clear_prompt=True)
                return
            if action == "inbox":
                await _send_bank_reconciliation_inbox(interaction, actor_key)
            if action == 'resync':
                await _resync_bank_information(interaction, actor_key)

    return BankReconciliationDigestView(handle_action, actor_key=str(actor_key))


def register_persistent_bank_reconciliation_views(client: Any) -> None:
    global _PERSISTENT_DIGEST_VIEW_REGISTERED
    if _PERSISTENT_DIGEST_VIEW_REGISTERED:
        return
    add_view = getattr(client, "add_view", None)
    if not callable(add_view):
        return
    for actor_key, _mention in _notification_users():
        add_view(persistent_bank_reconciliation_digest_view(actor_key))
    _PERSISTENT_DIGEST_VIEW_REGISTERED = True


def _interaction_actor_key(interaction: Any) -> str:
    return str(getattr(getattr(interaction, "user", None), "id", "") or "")


def _digest_prompt_metadata(interaction: Any) -> dict[str, str]:
    message_id = str(getattr(getattr(interaction, "message", None), "id", "") or "unknown")
    return {"prompt_message_id": message_id}


async def _claim_bank_reconciliation_prompt(interaction: Any, actor_key: str) -> bool:
    metadata = _digest_prompt_metadata(interaction)
    if await asyncio.to_thread(has_system_event, actor_key, "bank_reconciliation_prompt_started", metadata):
        return False
    return await asyncio.to_thread(
        record_system_event,
        actor_key,
        "bank_reconciliation_prompt_started",
        metadata,
        f"Bank reconciliation prompt started for message {metadata['prompt_message_id']}",
    )


async def _clear_digest_prompt_buttons(interaction: Any) -> None:
    message = getattr(interaction, "message", None)
    edit = getattr(message, "edit", None)
    if not callable(edit):
        return
    async_edit = cast(Callable[..., Awaitable[Any]], edit)
    try:
        await async_edit(view=None)
    except discord.NotFound:
        logger.info("Bank reconciliation digest message was already deleted before buttons could be cleared")
    except Exception:
        logger.exception("Failed to clear bank reconciliation digest buttons")


def prepare_bank_reconciliation_digest(
    actor_key: str,
    mention: str,
    current: date,
    *,
    mark_sent: bool,
    force: bool = False,
) -> str | None:
    digest = prepare_bank_reconciliation_digest_messages(
        actor_key,
        mention,
        current,
        mark_sent=mark_sent,
        force=force,
    )
    return "\n\n".join(digest.detail_messages or (digest.detail_message,)) if digest else None


def prepare_bank_reconciliation_digest_messages(
    actor_key: str,
    mention: str,
    current: date,
    *,
    mark_sent: bool,
    force: bool = False,
) -> PreparedBankReconciliationDigest | None:
    metadata = _digest_metadata(current)
    owner = get_user_config(actor_key)
    service = build_banking_service()
    events = _digest_events(actor_key, current)
    normal_sent = 'bank_reconciliation_digest_sent' in events
    recovery_sent = 'bank_reconciliation_recovery_digest_sent' in events
    recovering = bool(events & {'bank_connection_alert_sent', 'bank_reconciliation_resync_completed'})
    # Health alerts remain independent even when a normal digest was delivered.
    if not force and (recovery_sent or (normal_sent and not recovering)) and not service.connection_issues(owner.budget_owner_key):
        return None
    sync_error: str | None = None
    month_start = current.replace(day=1).isoformat()
    if service.config.configured:
        try:
            asyncio.run(service.sync_owner(owner.budget_owner_key))
        except Exception as exc:
            sync_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Bank sync failed before reconciliation digest; using cached data",
                extra={"actor_key": actor_key, "error": sync_error},
            )

    issues = service.connection_issues(owner.budget_owner_key)
    if sync_error or issues:
        event_type = 'bank_connection_alert_sent'
        if not force and event_type in events:
            return None
        reconnect = [issue for issue in issues if issue['needsReconnect']]
        names = ', '.join(str(issue['institution'])[:100] for issue in reconnect)
        text = (f'{mention} **Reconnect {names} to resume bank updates.**'
                if reconnect else f'{mention} **Bank sync failed.**')
        text += '\nTransactions and Pending statuses may be out of date. Saved review history is preserved.'
        for issue in issues[:5]:
            if issue['checkedAt']:
                checked = datetime.fromisoformat(issue['checkedAt']).astimezone(PACIFIC_TZ)
                text += f"\n{issue['institution']}: last successful sync {checked:%b %d, %I:%M %p} Pacific."
        base_url = (service.config.public_base_url or '').rstrip('/')
        links = tuple((f"Reconnect {issue['institution']}", bank_reconnect_url(
            actor_key, owner.budget_owner_key, issue['id'], base_url)) for issue in reconnect) if base_url else ()
        text += ('\nUse Reconnect below, open Reconcile in the app, or run `/bank_reconnect` for a fresh link. Links expire after 15 minutes.'
                 if reconnect else '\nUse Resync bank below or Resync bank information in the app. The morning digest refreshes after recovery.')
        if mark_sent and not record_system_event(actor_key, event_type, metadata,
                f'Bank connection alert sent for {current.isoformat()}'):
            return None
        return PreparedBankReconciliationDigest(public_message=text, detail_message=text,
            owner_key=owner.budget_owner_key, event_type=event_type, reconnect_links=links)

    event_type = 'bank_reconciliation_recovery_digest_sent' if recovering else 'bank_reconciliation_digest_sent'
    if not force and event_type in events:
        return None
    try:
        preview = service.reconciliation_preview(
            owner.budget_owner_key,
            limit=50,
            actor_key=actor_key,
            start_date=month_start,
        )
        unresolved = service.unresolved_reconciliation_items(
            owner.budget_owner_key,
            limit=25,
            start_date=month_start,
        )
        matched_items = [item for item in preview.items if item.status == "matched"]
        if force or recovering:
            matched_by_id = {item.id: item for item in matched_items}
            for item in service.matched_reconciliation_items(
                owner.budget_owner_key,
                limit=100,
                start_date=month_start,
            ):
                matched_by_id.setdefault(item.id, item)
            matched_items = list(matched_by_id.values())
        report_matches = service.reconciliation_report_matches(
            owner.budget_owner_key,
            matched_items,
            actor_key=actor_key,
            limit=100,
        )
    except Exception:
        logger.exception("Failed to prepare bank reconciliation digest", extra={"actor_key": actor_key})
        return None

    unresolved_count = len(unresolved)
    matched_count = len(matched_items)
    if not unresolved_count and not matched_count and not recovering:
        return None
    report_preview_items = {item.id: item for item in preview.items}
    for item in matched_items:
        report_preview_items.setdefault(item.id, item)
    report_preview = replace(preview, items=list(report_preview_items.values()))

    if mark_sent:
        if not record_system_event(
            actor_key,
            event_type,
            {
                **metadata,
                "unresolved_count": str(len(unresolved)),
                "matched_count": str(matched_count),
            },
            f"Bank reconciliation digest sent for {current.isoformat()}",
        ):
            return None

    public_message = format_bank_reconciliation_public_prompt(
        mention, unresolved_count, matched_count=matched_count, sync_error=sync_error)
    if recovering:
        public_message = ('Bank information resynced; reconciliation refreshed.\n' + public_message
            if unresolved_count or matched_count else
            f'{mention} bank information resynced; no posted transactions need review. '
            'Pending charges remain tentative. Use View Inbox to check the current bank cache.')
    return PreparedBankReconciliationDigest(
        public_message=public_message,
        detail_messages=tuple(format_bank_reconciliation_digest_chunks(
            mention,
            report_preview,
            unresolved,
            report_matches=report_matches,
            sync_error=sync_error,
        )),
        detail_message=format_bank_reconciliation_digest(
            mention,
            report_preview,
            unresolved,
            report_matches=report_matches,
            sync_error=sync_error,
        ),
        report_matches=tuple(report_matches),
        item_ids=tuple(int(item.id) for item in unresolved),
        reviewed_items=tuple({item.id: item for item in [*unresolved, *matched_items]}.values()),
        owner_key=owner.budget_owner_key,
        owner_name=getattr(owner, "name", str(actor_key)),
        event_type=event_type,
    )


def prepare_bank_reconciliation_inbox_messages(
    actor_key: str,
    mention: str,
    current: date,
) -> PreparedBankReconciliationDigest | None:
    """Build the button-driven inbox from persisted reconciliation state only."""
    owner = get_user_config(actor_key)
    service = build_banking_service()
    month_start = current.replace(day=1).isoformat()
    unresolved = service.unresolved_reconciliation_items(
        owner.budget_owner_key,
        limit=25,
        start_date=month_start,
    )
    matched_items = service.matched_reconciliation_items(
        owner.budget_owner_key,
        limit=100,
        start_date=month_start,
    )
    cache_buckets = service.reconciliation_cache_buckets(
        owner.budget_owner_key,
        start_date=month_start,
    )
    if not unresolved and not matched_items:
        return None

    items_by_id = {item.id: item for item in unresolved}
    for item in matched_items:
        items_by_id.setdefault(item.id, item)
    preview = ReconciliationPreview(
        owner_key=owner.budget_owner_key,
        items=list(items_by_id.values()),
        cached_transaction_count=cache_buckets.stored,
        candidate_transaction_count=len(items_by_id),
        cache_buckets=cache_buckets,
    )
    # Build a usable report without external reads first. Optional sheet detail
    # hydration happens separately with a short timeout before delivery.
    report_matches = service.reconciliation_report_matches(
        owner.budget_owner_key,
        matched_items,
        actor_key=None,
        limit=100,
    )
    unresolved_count = len(unresolved)
    matched_count = len(matched_items)
    detail_messages = tuple(
        format_bank_reconciliation_digest_chunks(
            mention,
            preview,
            unresolved,
            report_matches=report_matches,
        )
    )
    return PreparedBankReconciliationDigest(
        public_message=format_bank_reconciliation_public_prompt(
            mention,
            unresolved_count,
            matched_count=matched_count,
        ),
        detail_messages=detail_messages,
        detail_message=format_bank_reconciliation_digest(
            mention,
            preview,
            unresolved,
            report_matches=report_matches,
        ),
        report_matches=tuple(report_matches),
        item_ids=tuple(int(item.id) for item in unresolved),
        reviewed_items=tuple({item.id: item for item in [*unresolved, *matched_items]}.values()),
        owner_key=owner.budget_owner_key,
        owner_name=getattr(owner, "name", str(actor_key)),
        preview=preview,
    )


def format_bank_reconciliation_public_prompt(
    mention: str,
    unresolved_count: int,
    *,
    matched_count: int = 0,
    sync_error: str | None = None,
) -> str:
    noun = "item" if unresolved_count == 1 else "items"
    verb = "needs" if unresolved_count == 1 else "need"
    if unresolved_count:
        lines = [
            f"{mention} bank reconciliation has `{unresolved_count}` {noun} that {verb} review.",
            "Use `Reconcile Now` to review one transaction at a time, or `View Inbox` to see the full inbox first.",
        ]
    else:
        match_noun = "match" if matched_count == 1 else "matches"
        lines = [
            f"{mention} bank reconciliation confirmed `{matched_count}` automatic {match_noun}.",
            "Use `View Inbox` to inspect the reconciliation report.",
        ]
    if sync_error:
        lines.append("Bank sync warning: using cached bank data.")
    return "\n".join(lines)


def format_bank_reconciliation_digest(
    mention: str,
    preview: ReconciliationPreview,
    unresolved: list,
    *,
    report_matches: list | None = None,
    sync_error: str | None = None,
) -> str:
    return "\n\n".join(
        format_bank_reconciliation_digest_chunks(
            mention,
            preview,
            unresolved,
            report_matches=report_matches,
            sync_error=sync_error,
        )
    )


def format_bank_reconciliation_digest_chunks(
    mention: str,
    preview: ReconciliationPreview,
    unresolved: list,
    *,
    report_matches: list | None = None,
    sync_error: str | None = None,
    max_chars: int = 1850,
) -> list[str]:
    matched_count = len([item for item in preview.items if item.status == "matched"])
    if unresolved:
        noun = "item" if len(unresolved) == 1 else "items"
        verb = "needs" if len(unresolved) == 1 else "need"
        lines = [
            f"{mention} bank reconciliation found `{len(unresolved)}` {noun} that {verb} review.",
        ]
    else:
        match_noun = "match" if matched_count == 1 else "matches"
        lines = [
            f"{mention} bank reconciliation found no unresolved items and confirmed `{matched_count}` automatic {match_noun}.",
        ]
    if sync_error:
        lines.extend(["", "Bank sync warning: using cached bank data for this digest."])
    buckets = preview.cache_buckets
    lines.extend(
        [
            "",
            "Bank cache:",
            f"- Stored bank transactions: `{buckets.stored}`",
            f"- Needs review: `{buckets.needs_review}`",
            f"- Matched automatically: `{buckets.matched}`",
            f"- Confirmed/logged: `{buckets.confirmed}`",
            f"- Ignored: `{buckets.ignored}`",
            f"- Pending: `{buckets.pending}`",
        ]
    )
    chunks = [_fit_chunk("\n".join(lines), max_chars=max_chars)]
    if unresolved:
        for section in format_reconciliation_review_chunks(unresolved, max_chars=max_chars):
            chunks = _append_digest_chunk(chunks, section, max_chars=max_chars)
    for section in format_reconciliation_match_report_chunks(report_matches or [], max_chars=max_chars):
        chunks = _append_digest_chunk(chunks, section, max_chars=max_chars)
    return chunks


def _fit_chunk(value: str, *, max_chars: int) -> str:
    return value if len(value) <= max_chars else value[:max_chars]


def _append_digest_chunk(chunks: list[str], section: str, *, max_chars: int) -> list[str]:
    if not chunks:
        return [section]
    candidate = chunks[-1] + "\n\n" + section
    if len(candidate) <= max_chars:
        chunks[-1] = candidate
    else:
        chunks.append(_fit_chunk(section, max_chars=max_chars))
    return chunks


async def run_bank_reconciliation_loop(client: Any) -> None:
    global _BANK_RECONCILIATION_WAKE
    wake = asyncio.Event()
    _BANK_RECONCILIATION_WAKE = wake
    try:
        while True:
            wake.clear()
            try:
                await send_due_bank_reconciliation_digest(client)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Bank reconciliation loop failed")
            try:
                await asyncio.wait_for(wake.wait(), timeout=_check_interval_seconds())
            except TimeoutError:
                pass
    finally:
        if _BANK_RECONCILIATION_WAKE is wake:
            _BANK_RECONCILIATION_WAKE = None


def ensure_bank_reconciliation_loop(client: Any) -> asyncio.Task | None:
    global _BANK_RECONCILIATION_TASK
    if not _bank_reconciliation_enabled():
        return None
    if _BANK_RECONCILIATION_TASK is None or _BANK_RECONCILIATION_TASK.done():
        _BANK_RECONCILIATION_TASK = asyncio.create_task(run_bank_reconciliation_loop(client))
    return _BANK_RECONCILIATION_TASK
