import { main } from "./src/cli.ts";
import { safeError } from "./src/types.ts";

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}
