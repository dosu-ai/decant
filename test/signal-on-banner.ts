// Preloaded into a spawned `decant serve`: sends the process SIGTERM as soon as
// the banner is written, the earliest moment a script reading stderr could.
const write = process.stderr.write.bind(process.stderr);
let sent = false;
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const result = (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  if (!sent && String(chunk).includes("Decant is running.")) {
    sent = true;
    process.kill(process.pid, "SIGTERM");
  }
  return result;
}) as typeof process.stderr.write;
