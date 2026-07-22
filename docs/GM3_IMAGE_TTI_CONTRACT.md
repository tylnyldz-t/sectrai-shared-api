# Synthetic text-to-image connector

`image-tti` is a governed, synthetic-only `media-generation` connector. It
creates local SVG review candidates; it has no provider credential, endpoint,
network client, ComfyUI dispatch, GPU worker, publishing route, or live mode.
`LIVE_DISABLED` is the only accepted mode.

## Required configuration

```dotenv
GCL_IMAGE_LIVE_MODE=LIVE_DISABLED
GCL_IMAGE_MAX_COST_CENTS=25
GCL_IMAGE_MAX_ITEMS=2
GCL_IMAGE_OWNER_REVIEW_TTL_SECONDS=900
GCL_IMAGE_DAILY_RUN_QUOTA=10
GCL_IMAGE_DAILY_ITEM_QUOTA=20
```

The connector fails closed if limits are absent, invalid, or exceed its 32
candidate bound. Review TTLs are limited to 60 seconds through 24 hours.

## Lifecycle

1. `GovernedConnectorRunner` requires owner approval, a permitted
   `image:generate` scope, valid identity/correlation values, positive cost
   and item counts, audit availability, and daily quota reservation.
2. The connector applies the baseline family-safety filter before audit or
   quota work. An optional local filter can only narrow that result.
3. A successful run emits redacted prompt digests, a non-executable SDXL plan,
   `LIVE_DISABLED`, and `publication: blocked` candidates. Raw prompts never
   enter candidates or audit detail.
4. `issueSyntheticImageCandidates` records a redacted candidate fingerprint,
   deadline, and source-run audit hash. It accepts only a governed result.
5. A different owner may like or reject an issued candidate before its
   deadline. Both terminal decisions are recorded in the audit chain, and all
   returned values remain `publication: blocked`.

The durable audit, quota, issuance, and owner-review records use reserved
`gcl-*` modules and are not exposed through generic product CRUD. The host is
still responsible for authenticating the maker, issuer, and owner checker.
