export function lineAt(sql, index) {
  let line = 1;
  for (let i = 0; i < Math.min(index, sql.length); i++) if (sql[i] === '\n') line++;
  return line;
}

// Offsets are half-open JavaScript string offsets, so callers can slice the
// original SQL without translating Unicode or losing CRLF line boundaries.
// Quoted names remain available as operands, but can never become keywords.
export function scanSql(sql) {
  const chars = sql.split('');
  const comments = [];
  const tokens = [];
  const errors = [];
  const unterminated = (start, construct) =>
    errors.push({ start, message: `Unterminated ${construct}.` });
  const dollarTag = /^\$(?:[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*)?\$/i;
  let i = 0;
  const blank = (start, end) => {
    for (let j = start; j < end; j++) {
      if (chars[j] !== '\n' && chars[j] !== '\r') chars[j] = ' ';
    }
  };
  const emit = (kind, start, extra = {}) => {
    const text = sql.slice(start, i);
    tokens.push({ kind, text, value: text.toLowerCase(), start, end: i, ...extra });
    if (kind !== 'word' && kind !== 'symbol') blank(start, i);
  };

  while (i < sql.length) {
    const start = i;
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      if (sql.startsWith('--', i)) {
        while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      } else {
        i += 2;
        let depth = 1;
        while (i < sql.length && depth > 0) {
          if (sql.startsWith('/*', i)) {
            depth++;
            i += 2;
          } else if (sql.startsWith('*/', i)) {
            depth--;
            i += 2;
          } else i++;
        }
        if (depth > 0) unterminated(start, 'block comment');
      }
      comments.push({ start, end: i, line: lineAt(sql, start), text: sql.slice(start, i) });
      blank(start, i);
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++];
      const escaped =
        quote === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(Math.max(0, start - 2), start));
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') i = Math.min(i + 2, sql.length);
        else if (sql[i] === quote) {
          i++;
          if (sql[i] !== quote) {
            closed = true;
            break;
          }
          i++;
        } else i++;
      }
      if (!closed) unterminated(start, quote === '"' ? 'quoted identifier' : 'string');
      emit(
        quote === '"' ? 'identifier' : 'string',
        start,
        quote === '"' ? { value: sql.slice(start + 1, i - 1).replace(/""/g, '"') } : {},
      );
    } else if (sql[i] === '$' && dollarTag.test(sql.slice(i))) {
      const tag = sql.slice(i).match(dollarTag)[0];
      const bodyStart = i + tag.length;
      const closing = sql.indexOf(tag, bodyStart);
      if (closing < 0) unterminated(start, 'dollar-quoted body');
      const bodyEnd = closing < 0 ? sql.length : closing;
      i = closing < 0 ? sql.length : closing + tag.length;
      emit('body', start, { bodyStart, bodyEnd });
    } else if (/[a-z_\u0080-\uffff]/i.test(sql[i])) {
      i++;
      while (i < sql.length && /[a-z0-9_$\u0080-\uffff]/i.test(sql[i])) i++;
      emit('word', start);
    } else {
      i++;
      if (!/\s/.test(sql[start])) emit('symbol', start);
    }
  }

  const code = chars.join('');
  const statements = [];
  let start = 0;
  const parentheses = [];
  const finish = (end) => {
    let first = start;
    while (first < end && /\s/.test(code[first])) first++;
    if (first < end)
      statements.push({
        text: code.slice(first, end),
        start: first,
        end,
        line: lineAt(sql, first),
      });
    start = end + 1;
  };
  for (let j = 0; j < code.length; j++) {
    if (code[j] === '(') parentheses.push(j);
    else if (code[j] === ')') parentheses.pop();
    else if (code[j] === ';' && parentheses.length === 0) finish(j);
  }
  if (parentheses.length) unterminated(parentheses[0], 'parenthesis');
  finish(code.length);
  return { code, comments, statements, tokens, errors };
}

export function tokenize(sql) {
  const { code, comments, statements, errors } = scanSql(sql);
  return { code, comments, statements, errors };
}
