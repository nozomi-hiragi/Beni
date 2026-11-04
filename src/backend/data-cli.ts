import { cloneProject, migrateData } from './migration';
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'migrate' && args.length === 1) {
    await migrateData(args[0]!);
    console.log('Data migration complete.');
  } else if (command === 'clone' && args.length === 2) {
    console.log(JSON.stringify(await cloneProject(args[0]!, args[1]!)));
  } else throw Error('Stop Beni first. Usage: bun run migrate:data -- <data-directory> | bun run clone:project -- <source-project> <destination-without-beni>');
} catch (error) {
  const message = error instanceof SyntaxError ? 'Invalid JSON data' : error !== null && typeof error === 'object' && ('code' in error || 'errno' in error) ? 'Data operation failed' : error instanceof Error ? error.message : 'Data operation failed';
  console.error(message);
  process.exitCode = 1;
}
