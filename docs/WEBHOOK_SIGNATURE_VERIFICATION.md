# Webhook Signature Verification (v1)

## Overview

Every webhook delivery from Nova Launch is signed with an HMAC-SHA256
signature derived from the destination subscription's secret. Receivers
should verify this signature before trusting a delivery's payload.

## Header

The signature is sent in the `X-Webhook-Signature` request header:

```
X-Webhook-Signature: v1.<unix_timestamp>.<hmac_sha256_hex>
```

| Part | Meaning |
|------|---------|
| `v1` | Signature scheme version |
| `unix_timestamp` | Seconds since epoch when the signature was generated |
| `hmac_sha256_hex` | Hex-encoded HMAC-SHA256 digest |

## Signed message

The digest is computed over:

```
<unix_timestamp>.<raw_request_body>
```

using the webhook subscription's secret as the HMAC key. The
`raw_request_body` is the exact bytes sent on the wire (the JSON-serialized
payload — or its gzip-decompressed form, if `Content-Encoding: gzip` is
present — before any further parsing).

## Verifying a delivery (pseudocode)

```text
header = request.headers["X-Webhook-Signature"]      # "v1.<ts>.<hex>"
version, timestamp, signature = header.split(".")

message = f"{timestamp}.{raw_body}"
expected = hmac_sha256_hex(key=subscription_secret, message=message)

if not constant_time_equal(signature, expected):
    reject()

# Recommended: also reject if abs(now() - timestamp) exceeds your
# acceptable replay window (Nova Launch uses 300 seconds for inbound
# verification).
```

A reference implementation lives in
[`backend/src/utils/crypto.ts`](../backend/src/utils/crypto.ts)
(`generateWebhookSignature` / `verifyWebhookSignature`).

## Checking a past delivery in the dashboard

The delivery log viewer's verification badge (✓ verified / ✗ unverified)
recomputes this same signature server-side, using the subscription's
*current* secret, against the payload exactly as it was stored at delivery
time. An **unverified** result usually means:

- The subscription's secret was rotated after this delivery was sent.
- The stored payload or signature was corrupted or tampered with.

The badge also shows the last 8 characters of the signing key
(`keyId`) so you can confirm whether a mismatch lines up with a known key
rotation.
