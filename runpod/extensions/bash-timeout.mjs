export default function bashTimeout(pi) {
  const configured = Number(process.env.BENCH_BASH_TIMEOUT_SECONDS ?? 120);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 120;

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" || !event.input) return;
    const requested = Number(event.input.timeout);
    if (event.input.timeout === undefined || !Number.isFinite(requested) || requested > timeout) {
      event.input.timeout = timeout;
    }
  });
}
