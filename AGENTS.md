# ForgeBench development instructions

- Keep the benchmark Linux-only and dependency-free at runtime.
- Never place reference implementations or private evaluator source in an agent
  bundle.
- Product correctness is the primary gate. Performance cannot compensate for a
  correctness regression.
- Add or update tests whenever the harness, parser, scoring, or task contract
  changes.
- Raw event streams and Prometheus snapshots are evidence. Derived summaries
  must remain reproducible from those files.

