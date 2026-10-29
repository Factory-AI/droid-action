# Synthetic review acceptance fixture

This small fixture is only for a dedicated draft acceptance PR. Do not merge it.
It does not handle real users, money, network requests, credentials, or
infrastructure.

The example report calls each documented contract:

- Three units at 500 cents each have a subtotal of 1500 cents.
- The zero-based first page of A, B, C with page size two contains A and B.
- A member who does not own the report cannot view it.
- An admin may view a report without owning it.

These are expected oracle values, not claims that tests were run.
