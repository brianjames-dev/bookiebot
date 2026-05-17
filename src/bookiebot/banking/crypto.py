from __future__ import annotations

import base64
import hashlib
import hmac
import os


class TokenCipher:
    """Small authenticated stream cipher for Plaid tokens.

    This is intentionally stdlib-only so the first banking slice does not add
    deployment dependencies. It protects tokens at rest from casual disclosure,
    while the env-backed key remains the operational secret.
    """

    VERSION = "v1"
    NONCE_SIZE = 16
    TAG_SIZE = 32

    def __init__(self, key: str):
        normalized = key.strip()
        if not normalized:
            raise ValueError("BANK_TOKEN_ENCRYPTION_KEY is required")
        self._key = hashlib.sha256(normalized.encode("utf-8")).digest()

    def encrypt(self, value: str) -> str:
        plaintext = value.encode("utf-8")
        nonce = os.urandom(self.NONCE_SIZE)
        keystream = self._keystream(nonce, len(plaintext))
        ciphertext = bytes(a ^ b for a, b in zip(plaintext, keystream))
        tag = hmac.new(self._key, nonce + ciphertext, hashlib.sha256).digest()
        payload = nonce + tag + ciphertext
        return f"{self.VERSION}:{base64.urlsafe_b64encode(payload).decode('ascii')}"

    def decrypt(self, value: str) -> str:
        prefix = f"{self.VERSION}:"
        if not value.startswith(prefix):
            raise ValueError("Unsupported encrypted token format")
        payload = base64.urlsafe_b64decode(value[len(prefix):].encode("ascii"))
        if len(payload) < self.NONCE_SIZE + self.TAG_SIZE:
            raise ValueError("Encrypted token payload is too short")

        nonce = payload[: self.NONCE_SIZE]
        tag = payload[self.NONCE_SIZE : self.NONCE_SIZE + self.TAG_SIZE]
        ciphertext = payload[self.NONCE_SIZE + self.TAG_SIZE :]
        expected_tag = hmac.new(self._key, nonce + ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            raise ValueError("Encrypted token authentication failed")

        keystream = self._keystream(nonce, len(ciphertext))
        plaintext = bytes(a ^ b for a, b in zip(ciphertext, keystream))
        return plaintext.decode("utf-8")

    def _keystream(self, nonce: bytes, length: int) -> bytes:
        blocks: list[bytes] = []
        counter = 0
        while sum(len(block) for block in blocks) < length:
            counter_bytes = counter.to_bytes(8, "big")
            blocks.append(hmac.new(self._key, nonce + counter_bytes, hashlib.sha256).digest())
            counter += 1
        return b"".join(blocks)[:length]

