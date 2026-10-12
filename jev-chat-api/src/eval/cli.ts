import "dotenv/config";
import { main } from "./run-eval";
import { runCli } from "./run-cli";

void runCli(main, process);
