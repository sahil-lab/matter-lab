// Infrastructure-failure fixture only: never emits any scientific result.
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (JSON.parse(input).testMode === 'overflow') process.stdout.write('x'.repeat(1024 * 1024));
else setTimeout(() => {}, 60_000);
