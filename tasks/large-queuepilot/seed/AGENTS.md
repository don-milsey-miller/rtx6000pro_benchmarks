# Product task instructions

- Build the complete product in `SPEC.md`; this is a greenfield implementation.
- Linux and Node.js 24 are the target. Use only the standard library.
- You may change any file and add tests. Independent black-box evaluation uses
  pristine checks outside this repository.
- Work in milestones and continuously run tests. Verify restart persistence,
  tenant isolation, optimistic concurrency, idempotency, and SSE end to end.
- Do not weaken authorization or leak tenant data to simplify the task.
- Finish only after `npm test` passes and the service shuts down cleanly.

