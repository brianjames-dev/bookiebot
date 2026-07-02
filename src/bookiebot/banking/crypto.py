from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.fernet import Fernet, InvalidToken


class TokenCipher:
    """Versioned token cipher for Plaid access tokens at rest.

    ``v2`` uses Fernet (AES-CBC + HMAC). ``v1`` remains decrypt-only so existing
    rows can be read and re-encrypted on the next write.
    """

    VERSION_V1 = "v1"
    VERSION_V2 = "v2"
    NONCE_SIZE = 16
    TAG_SIZE = 32

    def __init__(self, key: str):
        normalized = key.strip()
        if not normalized:
            raise ValueError("BANK_TOKEN_ENCRYPTION_KEY is required")
        self._raw_key = normalized
        self._v1_key = hashlib.sha256(normalized.encode("utf-8")).digest()
        self._fernet = Fernet(base64.urlsafe_b64encode(self._v1_key))

    def encrypt(self, value: str) -> str:
        token = self._fernet.encrypt(value.encode("utf-8")).decode("ascii")
        return f"{self.VERSION_V2}:{token}"

    def decrypt(self, value: str) -> str:
        if value.startswith(f"{self.VERSION_V2}:"):
            try:
                return self._fernet.decrypt(value[len(self.VERSION_V2) + 1 :].encode("ascii")).decode("utf-8")
            except InvalidToken as exc:
                raise ValueError("Encrypted token authentication failed") from exc
        if value.startswith(f"{self.VERSION_V1}:"):
            return self._decrypt_v1(value)
        raise ValueError("Unsupported encrypted token format")

    def _decrypt_v1(self, value: str) -> str:
        payload = base64.urlsafe_b64decode(value[len(self.VERSION_V1) + 1 :].encode("ascii"))
        if len(payload) < self.NONCE_SIZE + self.TAG_SIZE:
            raise ValueError("Encrypted token payload is too short")
        nonce = payload[: self.NONCE_SIZE]
        tag = payload[self.NONCE_SIZE : self.NONCE_SIZE + self.TAG_SIZE]
        ciphertext = payload[self.NONCE_SIZE + self.TAG_SIZE :]
        expected_tag = hmac.new(self._v1_key, nonce + ciphertext, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            raise ValueError("Encrypted token authentication failed")
        keystream = self._v1_keystream(nonce, len(ciphertext))
        plaintext = bytes(a ^ b for a, b in zip(ciphertext, keystream))
        return plaintext.decode("utf-8")

    def _v1_keystream(self, nonce: bytes, length: int) -> bytes:
        blocks: list[bytes] = []
        counter = 0
        while sum(len(block) for block in blocks) < length:
            counter_bytes = counter.to_bytes(8, "big")
            blocks.append(hmac.new(self._v1_key, nonce + counter_bytes, hashlib.sha256).digest())
            counter += 1
        return b"".join(blocks)[:length]

    def _encrypt_v1_for_tests(self, value: str) -> str:
        plaintext = value.encode("utf-8")
        nonce = os.urandom(self.NONCE_SIZE)
        keystream = self._v1_keystream(nonce, len(plaintext))
        ciphertext = bytes(a ^ b for a, b in zip(plaintext, keystream))
        tag = hmac.new(self._v1_key, nonce + ciphertext, hashlib.sha256).digest()
        payload = nonce + tag + ciphertext
        return f"{self.VERSION_V1}:{base64.urlsafe_b64encode(payload).decode('ascii')}"
