import pytest

from bookiebot.banking.crypto import TokenCipher


def test_token_cipher_round_trips_without_plaintext():
    cipher = TokenCipher("test-secret-key")

    encrypted = cipher.encrypt("access-sandbox-123")

    assert encrypted != "access-sandbox-123"
    assert "access-sandbox-123" not in encrypted
    assert cipher.decrypt(encrypted) == "access-sandbox-123"


def test_token_cipher_rejects_wrong_key():
    encrypted = TokenCipher("one-key").encrypt("access-sandbox-123")

    with pytest.raises(ValueError, match="authentication failed"):
        TokenCipher("other-key").decrypt(encrypted)

