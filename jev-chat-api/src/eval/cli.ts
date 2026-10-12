import "dotenv/config";
import { main } from "./run-eval";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 1;
  });
