import { isAbsolute } from "node:path";

export type LocalRunnerRequest = {
  binaryPath: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
};

export type LocalRunnerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};

export type LocalRunner = (request: LocalRunnerRequest) => Promise<LocalRunnerResult>;

type OutputBudget = {
  used: number;
  max: number;
};

function takeBytes(budget: OutputBudget, value: Uint8Array): Uint8Array {
  const remaining = Math.max(0, budget.max - budget.used);
  const accepted = value.byteLength <= remaining ? value : value.subarray(0, remaining);
  budget.used += accepted.byteLength;
  return accepted;
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array>,
  budget: OutputBudget,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const accepted = takeBytes(budget, value);
      if (accepted.byteLength > 0) {
        chunks.push(decoder.decode(accepted, { stream: true }));
      }
      if (accepted.byteLength !== value.byteLength) {
        onLimit();
        break;
      }
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

function validateRunnerRequest(request: LocalRunnerRequest): void {
  if (!isAbsolute(request.binaryPath) || request.binaryPath.includes("\0")) {
    throw new Error("Local runner binary path must be an absolute local path");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Local runner timeout must be a positive integer");
  }
  if (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1) {
    throw new Error("Local runner output limit must be a positive integer");
  }
  if (request.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new Error("Local runner arguments must be NUL-free strings");
  }
}

/**
 * Runs a local executable with an argv array, without invoking a shell.
 */
export const runLocal: LocalRunner = async (request): Promise<LocalRunnerResult> => {
  validateRunnerRequest(request);

  // Bun receives one executable plus one argument per array entry. No shell
  // interpolation or command-string evaluation is involved.
  const subprocess = Bun.spawn([request.binaryPath, ...request.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const budget: OutputBudget = { used: 0, max: request.maxOutputBytes };
  let timedOut = false;
  let outputLimitExceeded = false;
  let terminated = false;

  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    subprocess.kill();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);

  const stdoutPromise = readLimitedStream(
    subprocess.stdout as ReadableStream<Uint8Array>,
    budget,
    () => {
      outputLimitExceeded = true;
      terminate();
    },
  );
  const stderrPromise = readLimitedStream(
    subprocess.stderr as ReadableStream<Uint8Array>,
    budget,
    () => {
      outputLimitExceeded = true;
      terminate();
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    subprocess.exited,
  ]);
  clearTimeout(timer);

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    outputLimitExceeded,
  };
};
