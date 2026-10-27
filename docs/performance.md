# Performance — measured results

Reproduce: start the API with raised limits, then `npm run bench` (see `scripts/bench.ts`).

```
MIN_BOOKING_LEAD_MINUTES=0 RATE_LIMIT_AUTH_PER_MIN=100000 RATE_LIMIT_WRITE_PER_MIN=100000 \
RATE_LIMIT_GLOBAL_PER_MIN=10000000 BOOKING_HOLD_SECONDS=3000 npm run start   # after npm run build
npm run bench
```

## Environment (important caveat)

Authoring sandbox: **2 shared vCPUs, 8 GB RAM**, with the API (single Node process, request logging to file), PostgreSQL 16, Redis 7 **and the load generator all on the same machine**, ~4,000 doctors, ~450 slots. This is a *pessimistic, single-process* measurement — production runs ≥ 6 API pods on dedicated cores with a separate Aurora cluster — so treat results as evidence the design is sound, **not** as a production capacity guarantee. A real load test against staging is still required.

## Results (50 concurrent connections, 10 s per read test)

| Operation | Throughput | p50 | p97.5 | p99 | Errors |
|---|---|---|---|---|---|
| Doctor search by specialty + sort (cached) | ~2,100 req/s | 21 ms | 40 ms | 51 ms | 0 |
| Doctor text search (cached) | ~2,300 req/s | 19 ms | 42 ms | 50 ms | 0 |
| Doctor profile (cached) | ~3,600 req/s | 12 ms | 23 ms | 30 ms | 0 |
| Open slots (cached) | ~1,000 req/s | 47 ms | 70 ms | 74 ms | 0 |
| **Search, cache-busted** (every request hits Postgres) | ~470 req/s | 98 ms | 171 ms | 201 ms | 0 |

| Write path | Result |
|---|---|
| **Booking** (slot CAS + consultation + payment + outbox job + audit + idempotency record, one transaction), 25 concurrent clients | **≈ 116 bookings/s; p50 194 ms, p95 327 ms, p99 409 ms** |

(The run attempted 480 bookings; 450 succeeded and the remainder were correctly rejected by the 3-pending-bookings-per-patient cap because the benchmark reuses 150 patients.)

## Reading against the requirements

| Requirement | Evidence | Verdict |
|---|---|---|
| Reads p95 < 200 ms | cached p97.5 ≤ 70 ms; even the cache-busted worst case p97.5 = 171 ms on a shared 2-vCPU box | Met with margin; cache-busted tail is the thing to watch (add replica + index review under real data) |
| Writes p95 < 500 ms | booking p95 = 327 ms while saturating 25 concurrent writers | Met; the p50 is dominated by scrypt-free but fsync-bound commit + 6 statements on a shared disk |
| 100k consultations/day | needs ≈ 12 bookings/s at a 10× peak; measured ≈ 116/s on 2 shared vCPUs | ≈ 10× headroom on a single process |

## Where the time goes / next optimisations

* Booking is 1 transaction ≈ 8 statements; on Aurora (network-attached storage) expect +2–5 ms commit latency, offset by dedicated CPU.
* Uncached search cost grows with the doctor count: first step is `EXPLAIN` against production-like data, then a materialised "searchable doctors" view or OpenSearch (§12 of the architecture).
* Login/registration are intentionally CPU-expensive (scrypt ≈ 60–80 ms): they have their own rate limit and run on the same pods — if auth traffic grows, move to a dedicated auth deployment so hashing cannot steal CPU from booking.
