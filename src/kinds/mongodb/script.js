// The only code mongosh ever runs for the mongodb kind. It is the same text for every call: nothing in it comes
// from the agent, the inventory or the environment. What changes from call to call travels as data in the client's
// environment: MGO_URI (the connection string), MGO_DB (the database) and MGO_DOC (the command document as JSON).
// The script connects, parses the document with EJSON.parse, runs it with runCommand, closes a cursor the reply
// reports as open (with the id from the reply), and prints the reply. An error is one line on stderr and exit 1.
export const FIXED_SCRIPT = [
  'try {',
  '  const target = connect(process.env.MGO_URI).getSiblingDB(process.env.MGO_DB);',
  '  const reply = target.runCommand(EJSON.parse(process.env.MGO_DOC));',
  '  const cursor = reply.cursor;',
  '  if (cursor && String(cursor.id) !== \'0\') {',
  '    target.runCommand({ killCursors: cursor.ns.slice(cursor.ns.indexOf(\'.\') + 1), cursors: [cursor.id] });',
  '    cursor.id = 0;',
  '    process.stderr.write(\'more results exist: only the first batch is shown and the cursor was closed\\n\');',
  '  }',
  '  void process.stdout.write(EJSON.stringify(reply, null, 2) + \'\\n\');',
  '} catch (err) {',
  '  process.stderr.write(\'error: \' + String(err.codeName || err.name || \'Error\') + \': \' + String(err.message) + \'\\n\');',
  '  quit(1);',
  '}',
].join('\n');

// The arguments of every call: no connection at start, no banner, no rc file, and the fixed script.
export const CLIENT_ARGS = Object.freeze(['--nodb', '--quiet', '--norc', '--eval', FIXED_SCRIPT]);
