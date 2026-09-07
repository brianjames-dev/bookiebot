import pytest

from bookiebot.banking.crypto import TokenCipher


def test_token_cipher_round_trips_without_plaintext():
    cipher = TokenCipher("test-secret-key")

    encrypted = cipher.encrypt("access-sandbox-123")

    assert encrypted.startswith("v2:")
    assert encrypted != "access-sandbox-123"
    assert "access-sandbox-123" not in encrypted
    assert cipher.decrypt(encrypted) == "access-sandbox-123"


def test_token_cipher_rejects_wrong_key():
    encrypted = TokenCipher("one-key").encrypt("access-sandbox-123")

    with pytest.raises(ValueError, match="authentication failed"):
        TokenCipher("other-key").decrypt(encrypted)


def test_token_cipher_decrypts_legacy_v1_payloads():
    cipher = TokenCipher("test-secret-key")
    legacy = cipher._encrypt_v1_for_tests("access-sandbox-123")

    assert legacy.startswith("v1:")
    assert cipher.decrypt(legacy) == "access-sandbox-123"
    assert cipher.encrypt("access-sandbox-123").startswith("v2:")
