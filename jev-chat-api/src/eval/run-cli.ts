export interface CliProcess {
  exitCode?: number | string | null | undefined;
  stderr: { write(s: string): unknown };
  on(event: "beforeExit", listener: () => void): unknown;
  off(event: "beforeExit", listener: () => void): unknown;
}

/**
 * main()을 실행해 종료 코드를 설정한다.
 * main이 settle되기 전에 이벤트 루프가 비면(beforeExit) 대기 중 작업이 유실된 것이므로 오류로 끝낸다.
 */
export async function runCli(main: () => Promise<number>, proc: CliProcess): Promise<void> {
  let settled = false;
  const onBeforeExit = () => {
    if (settled) return;
    proc.stderr.write("평가가 끝나기 전에 이벤트 루프가 비었습니다(대기 중인 작업 유실)\n");
    proc.exitCode = 1;
  };
  proc.on("beforeExit", onBeforeExit);
  try {
    const code = await main();
    settled = true;
    proc.exitCode = code;
  } catch (e: unknown) {
    settled = true;
    proc.stderr.write(`${String((e as Error)?.message ?? e)}\n`);
    proc.exitCode = 1;
  } finally {
    proc.off("beforeExit", onBeforeExit);
  }
}
