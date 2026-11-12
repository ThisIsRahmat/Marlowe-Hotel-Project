(function () {
  "use strict";

  var SQLJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/";
  var MAX_SHOWN = 500;       // rows drawn in the results table
  var MAX_COUNTED = 100000;  // stop counting here so a runaway join can't freeze the page
  var STORAGE_KEY = "marlowe-last-query";
  var DEFAULT_QUERY = "SELECT *\nFROM marlowe.people\nLIMIT 10;";

  var DATA = window.MARLOWE_DATA;
  var TABLE_NAMES = Object.keys(DATA || {});

  // Every column is TEXT unless listed here.
  var COLUMN_TYPES = {
    people: { room_number: "INTEGER" },
    bar_tabs: { room_number: "INTEGER", price: "REAL" },
    phone_calls: { duration_seconds: "INTEGER" }
  };

  var KEYWORDS = ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "JOIN", "INNER", "LEFT", "RIGHT",
    "OUTER", "ON", "AS", "ORDER", "GROUP", "BY", "HAVING", "LIMIT", "LIKE", "BETWEEN", "DISTINCT",
    "IN", "IS", "NULL", "ASC", "DESC", "CASE", "WHEN", "THEN", "ELSE", "END", "UNION", "OFFSET",
    "COUNT", "SUM", "AVG", "MIN", "MAX", "LOWER", "UPPER"];
  var FUNCTIONS = ["COUNT", "SUM", "AVG", "MIN", "MAX", "LOWER", "UPPER", "LENGTH", "ROUND",
    "SUBSTR", "TRIM", "REPLACE", "COALESCE", "IFNULL", "DATE", "TIME", "DATETIME", "STRFTIME", "ABS"];

  var editor = document.getElementById("sql");
  var runBtn = document.getElementById("run");
  var copyBtn = document.getElementById("copy");
  var resetBtn = document.getElementById("reset");
  var statusEl = document.getElementById("status");
  var resultsEl = document.getElementById("results");
  var tableListEl = document.getElementById("table-list");

  var SQL = null;
  var db = null;
  var lastRun = null; // { sql, blocks, error } for the notebook copy

  // ---------- Schema helpers ----------

  function columnType(table, column) {
    return (COLUMN_TYPES[table] && COLUMN_TYPES[table][column]) || "TEXT";
  }

  var ALL_COLUMNS = {}; // lower-case column name -> [tables]
  TABLE_NAMES.forEach(function (t) {
    DATA[t].columns.forEach(function (c) {
      (ALL_COLUMNS[c.toLowerCase()] = ALL_COLUMNS[c.toLowerCase()] || []).push(t);
    });
  });

  // ---------- Building the database ----------

  function convert(value, type) {
    if (value === "") return null;
    if (type === "INTEGER" && /^-?\d+$/.test(value)) return parseInt(value, 10);
    if (type === "REAL" && value.trim() !== "" && !isNaN(Number(value))) return Number(value);
    return value;
  }

  function buildDatabase() {
    var database = new SQL.Database();
    database.run("ATTACH ':memory:' AS marlowe;");
    database.run("PRAGMA case_sensitive_like = ON;");
    database.run("BEGIN;");
    TABLE_NAMES.forEach(function (t) {
      var cols = DATA[t].columns;
      var defs = cols.map(function (c) { return c + " " + columnType(t, c); });
      database.run("CREATE TABLE marlowe." + t + " (" + defs.join(", ") + ");");
      var placeholders = cols.map(function () { return "?"; }).join(", ");
      var insert = database.prepare("INSERT INTO marlowe." + t + " VALUES (" + placeholders + ");");
      DATA[t].rows.forEach(function (row) {
        insert.run(row.map(function (v, i) { return convert(v, columnType(t, cols[i])); }));
      });
      insert.free();
    });
    database.run("COMMIT;");
    return database;
  }

  // ---------- Saving the query ----------

  function loadSavedQuery() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved !== null) return saved;
    } catch (e) { /* storage blocked: fall back to the default */ }
    return DEFAULT_QUERY;
  }

  function saveQuery() {
    try { window.localStorage.setItem(STORAGE_KEY, editor.value); } catch (e) { /* ignore */ }
  }

  // ---------- Small utilities ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function code(s) { return "<code>" + esc(s) + "</code>"; }

  function plural(n, word) {
    return n.toLocaleString("en-GB") + " " + word + (n === 1 ? "" : "s");
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  // Edit distance that counts a swapped pair of letters as one mistake.
  function distance(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    var d = [];
    for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }

  function closest(name, candidates, maxDist) {
    if (maxDist === undefined) maxDist = Math.max(2, Math.floor(name.length / 3));
    var best = null, bestDist = Infinity;
    candidates.forEach(function (c) {
      var dist = distance(name, c);
      if (dist < bestDist) { best = c; bestDist = dist; }
    });
    return bestDist <= maxDist ? best : null;
  }

  // Split SQL into tokens, skipping whitespace and comments.
  function tokenize(sql) {
    var tokens = [];
    var re = /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|<>|!=|<=|>=|\|\||[^\s]/g;
    var m;
    while ((m = re.exec(sql)) !== null) {
      var t = m[0];
      if (/^\s/.test(t) || t.indexOf("--") === 0 || t.indexOf("/*") === 0) continue;
      tokens.push(t);
    }
    return tokens;
  }

  function isWord(t) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(t); }
  function isKeyword(t) { return KEYWORDS.indexOf(t.toUpperCase()) !== -1; }
  function hasWord(tokens, word) {
    return tokens.some(function (t) { return t.toUpperCase() === word; });
  }

  // ---------- Friendly hints ----------

  function forgotFromHint(tokens) {
    if (hasWord(tokens, "SELECT") && !hasWord(tokens, "FROM")) {
      return "Did you forget " + code("FROM") + "? A query needs to say which table to look in, e.g. " +
        code("SELECT * FROM marlowe.people;");
    }
    return null;
  }

  function misspeltKeywordHints(tokens) {
    var hints = [];
    tokens.forEach(function (t) {
      if (!isWord(t) || t.length < 4 || isKeyword(t)) return;
      var lower = t.toLowerCase();
      if (ALL_COLUMNS[lower] || TABLE_NAMES.indexOf(lower) !== -1 || lower === "marlowe") return;
      var match = closest(t, KEYWORDS, t.length <= 5 ? 1 : 2);
      if (match && hints.length < 2) {
        hints.push("Is " + code(t) + " meant to be " + code(match) + "? Check the spelling.");
      }
    });
    return hints;
  }

  function columnHint(rawName, tokens) {
    var name = rawName.split(".").pop();
    var tables = ALL_COLUMNS[name.toLowerCase()];
    if (tables) {
      if (rawName.indexOf(".") !== -1) {
        return code(name) + " is a real column, but check the part before the dot in " + code(rawName) +
          ". It must be a table name or a short name (alias) you gave a table in FROM or JOIN.";
      }
      return code(name) + " is a real column, but it's in " + tables.map(code).join(", ") +
        ", not in the table(s) your query uses. Check your " + code("FROM") + " and " + code("JOIN") + ".";
    }
    var match = closest(name, Object.keys(ALL_COLUMNS));
    if (match) {
      return "There's no column called " + code(name) + ". Did you mean " + code(match) + "? (It's in " +
        ALL_COLUMNS[match].map(code).join(", ") + ".) Click a table on the left to see its columns.";
    }
    return "If " + code(name) + " is a piece of text you're looking for (not a column name), put it in " +
      "single quotes: " + code("'" + name + "'") + ". Otherwise, check the column names in the list on the left.";
  }

  // Find the token SQLite stopped at, and the two before it.
  function errorContext(near, tokens) {
    var idx = -1;
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].toUpperCase() === near.toUpperCase()) { idx = i; break; }
    }
    return { prev: idx > 0 ? tokens[idx - 1] : null, prev2: idx > 1 ? tokens[idx - 2] : null };
  }

  // e.g. WHERE door = Main entrance
  function unquotedTextHint(near, tokens) {
    var ctx = errorContext(near, tokens);
    if (ctx.prev && isWord(ctx.prev) && isWord(near) && !isKeyword(ctx.prev) && !isKeyword(near) &&
        ctx.prev2 && /^(=|<>|!=|<|>|<=|>=|LIKE)$/i.test(ctx.prev2)) {
      var text = ctx.prev + " " + near;
      return "Text must go inside single quotes. Try " + code("'" + text + "'") + " instead of " + code(text) + ".";
    }
    return null;
  }

  function syntaxHints(near, tokens) {
    var hints = [];
    var ctx = errorContext(near, tokens);
    var prev = ctx.prev;

    if (near.toUpperCase() === "FROM" && prev === ",") {
      hints.push("Remove the comma just before " + code("FROM") + ". The last column in a list doesn't need one.");
    } else if (prev && /^(ORDER|GROUP)$/i.test(prev) && near.toUpperCase() !== "BY") {
      hints.push("Write " + code(prev.toUpperCase() + " BY") + ", not just " + code(prev.toUpperCase()) + ".");
    } else if (prev && isWord(near) && !isKeyword(near) &&
               (/^['"\d)]/.test(prev) || (isWord(prev) && !isKeyword(prev)))) {
      hints.push("Is a comma missing between " + code(prev) + " and " + code(near) +
        "? Items in a list need commas, e.g. " + code("first_name, last_name") + ".");
    } else if (near === "(" || near === ")") {
      hints.push("Check your brackets: every " + code("(") + " needs a matching " + code(")") + ".");
    }
    return hints;
  }

  function getHints(message, sql) {
    var tokens = tokenize(sql);
    var hints = [];
    var m;

    // Curly quotes confuse SQLite in several different ways, so check for them first.
    if (/[‘’“”]/.test(sql)) {
      return ["Your query has curly quotes (" + code("‘ ’ “ ”") + "), which often " +
        "happen when you copy from slides or documents. Delete them and type straight quotes " + code("'") + " instead."];
    }

    if ((m = /no such table: (\S+)/.exec(message))) {
      var tableName = m[1].replace(/^(marlowe|main)\./i, "");
      var backticked = tokens.filter(function (t) { return /^`.*\..*`$/.test(t); })[0];
      if (backticked) {
        hints.push("Remove the backticks (" + code("`") + "). In this database, write " +
          code(backticked.replace(/`/g, "")) + " without them.");
      } else {
        var t = closest(tableName, TABLE_NAMES);
        hints.push(t
          ? "There's no table called " + code(tableName) + ". Did you mean " + code("marlowe." + t) + "?"
          : "There's no table called " + code(tableName) + ". Check the list of tables on the left. " +
            "Table names use underscores, e.g. " + code("marlowe.crime_scene_reports") + ".");
      }
    } else if ((m = /unknown database (\S+)/.exec(message))) {
      hints.push("The part before the dot should be " + code("marlowe") + ", e.g. " + code("marlowe.people") + ".");
    } else if ((m = /no such column: (\S+)/.exec(message))) {
      var noFrom = forgotFromHint(tokens);
      if (noFrom) hints.push(noFrom);
      hints.push(columnHint(m[1], tokens));
    } else if (/no tables specified/.test(message)) {
      hints.push(forgotFromHint(tokens) || "Your query needs " + code("FROM") + " followed by a table name.");
    } else if ((m = /near "([\s\S]*)": syntax error/.exec(message))) {
      var noFrom2 = forgotFromHint(tokens);
      if (noFrom2) hints.push(noFrom2);
      var unquoted = unquotedTextHint(m[1], tokens);
      if (unquoted) hints.push(unquoted);
      else hints = hints.concat(misspeltKeywordHints(tokens));
      if (!hints.length) hints = syntaxHints(m[1], tokens);
      if (!hints.length) {
        hints.push("SQLite got confused just before " + code(m[1]) + ". Look at the words right before it. " +
          "The usual causes are a missing comma, a missing quote mark, or a misspelt keyword.");
      }
    } else if ((m = /unrecognized token: "([\s\S]*)"/.exec(message))) {
      if (m[1].charAt(0) === "'") {
        hints.push("A piece of text is missing its closing quote. Check that every " + code("'") + " has a partner.");
      } else {
        hints.push("SQLite doesn't recognise " + code(m[1]) + ". Check for a stray symbol or a typo.");
      }
    } else if (/incomplete input/.test(message)) {
      hints.push("Your query ends too early. Check for a missing closing quote " + code("'") +
        ", a missing " + code(")") + ", or an unfinished last line.");
    } else if ((m = /ambiguous column name: (\S+)/.exec(message))) {
      var col = m[1].split(".").pop();
      hints.push(code(col) + " is in more than one of the tables you joined, so SQLite doesn't know which one you mean. " +
        "Put the table's name or alias in front, e.g. " + code("p." + col) + ".");
    } else if ((m = /no such function: (\S+)/.exec(message))) {
      var f = closest(m[1], FUNCTIONS);
      hints.push(f ? "Did you mean " + code(f + "()") + "?" : "There's no function called " + code(m[1]) + ". Check the spelling.");
    } else if (/misuse of aggregate|GROUP BY clause is required/i.test(message)) {
      hints.push("When you use " + code("COUNT()") + ", " + code("SUM()") + " and similar functions alongside " +
        "normal columns, you usually need " + code("GROUP BY") + ". If you're filtering on a count, use " +
        code("HAVING") + " rather than " + code("WHERE") + ".");
    }
    return hints;
  }

  // After a successful SELECT: "first_name last_name" is valid SQL (an alias) but is usually a missing comma.
  function missingCommaWarning(sql) {
    var tokens = tokenize(sql);
    var warnings = [];
    var depth = 0, inSelect = false, item = [];
    function checkItem() {
      if (item.length === 2 && isWord(item[1]) && !isKeyword(item[1]) && ALL_COLUMNS[item[1].toLowerCase()] &&
          /^[A-Za-z_][\w.]*$/.test(item[0])) {
        warnings.push("Did you forget a comma? " + code(item[0] + " " + item[1]) + " means “show " +
          item[0] + " but label it " + item[1] + "”. To show both columns, write " +
          code(item[0] + ", " + item[1]) + ".");
      }
      item = [];
    }
    tokens.forEach(function (t) {
      var up = t.toUpperCase();
      if (up === "SELECT" && depth === 0) { inSelect = true; item = []; return; }
      if (!inSelect) return;
      if (up === "DISTINCT" && item.length === 0) return;
      if (t === "(") depth++;
      if (t === ")") depth--;
      if (depth === 0 && (t === "," || up === "FROM" || t === ";")) {
        checkItem();
        if (up === "FROM" || t === ";") inSelect = false;
        return;
      }
      // Glue "p", ".", "first_name" back together as one item.
      if (t === "." && item.length) { item[item.length - 1] += "."; return; }
      if (item.length && /\.$/.test(item[item.length - 1])) { item[item.length - 1] += t; return; }
      item.push(t);
    });
    return warnings;
  }

  // ---------- Running queries ----------

  function runQuery() {
    if (!db) return;
    var sql = editor.value;
    saveQuery();
    resultsEl.innerHTML = "";
    if (!sql.trim()) {
      setStatus("The query box is empty. Type a query first.", "error");
      return;
    }

    var blocks = [];
    var error = null;
    try {
      var it = db.iterateStatements(sql);
      var stmt;
      while ((stmt = nextStatement(it)) !== null) {
        try {
          blocks.push(runStatement(stmt));
        } finally {
          stmt.free();
        }
      }
    } catch (e) {
      error = (e && e.message) ? e.message : String(e);
    }

    lastRun = { sql: sql, blocks: blocks, error: error };
    copyBtn.disabled = false;

    blocks.forEach(renderBlock);
    if (error) {
      renderError(error, sql, blocks.length > 0);
      setStatus("Your query has a problem. See the details below.", "error");
    } else if (!blocks.length) {
      setStatus("There was nothing to run. Is the query all comments?", "error");
    } else {
      var last = blocks[blocks.length - 1];
      setStatus(last.columns ? "Query ran: " + countText(last) + "." : last.message, "ok");
      var warnings = missingCommaWarning(sql);
      if (warnings.length) resultsEl.insertBefore(hintBox(warnings), resultsEl.firstChild);
    }
  }

  function nextStatement(it) {
    var r = it.next();
    return r.done ? null : r.value;
  }

  function runStatement(stmt) {
    var columns = stmt.getColumnNames();
    var rows = [], count = 0, capped = false;
    while (stmt.step()) {
      count++;
      if (rows.length < MAX_SHOWN) rows.push(stmt.get());
      if (count >= MAX_COUNTED) { capped = true; break; }
    }
    if (columns.length) return { columns: columns, rows: rows, count: count, capped: capped };

    var first = (tokenize(stmt.getSQL())[0] || "").toUpperCase();
    var message = "Done.";
    if (first === "INSERT" || first === "UPDATE" || first === "DELETE") {
      message = "Done. " + plural(db.getRowsModified(), "row") + " changed. Press Reset data to get the original data back.";
    }
    return { message: message };
  }

  function countText(block) {
    if (block.capped) return "more than " + plural(MAX_COUNTED, "row");
    return plural(block.count, "row");
  }

  // ---------- Rendering ----------

  function renderBlock(block) {
    var wrap = document.createElement("div");
    wrap.className = "result-block";
    var meta = document.createElement("p");
    meta.className = "result-meta";

    if (!block.columns) {
      meta.textContent = block.message;
      wrap.appendChild(meta);
      resultsEl.appendChild(wrap);
      return;
    }

    meta.textContent = countText(block).replace(/^m/, "M");
    if (block.count > block.rows.length) {
      var note = document.createElement("span");
      note.className = "truncated";
      note.textContent = " (showing the first " + plural(block.rows.length, "row") + ")";
      meta.appendChild(note);
    }
    wrap.appendChild(meta);

    var scroller = document.createElement("div");
    scroller.className = "table-wrap";
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", "Query results");

    var table = document.createElement("table");
    table.className = "results";
    var thead = table.createTHead().insertRow();
    block.columns.forEach(function (c) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = c;
      thead.appendChild(th);
    });
    var tbody = table.createTBody();
    block.rows.forEach(function (row) {
      var tr = tbody.insertRow();
      row.forEach(function (v) {
        var td = tr.insertCell();
        if (v === null) { td.textContent = "NULL"; td.className = "null"; }
        else { td.textContent = String(v); if (typeof v === "number") td.className = "num"; }
      });
    });
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    resultsEl.appendChild(wrap);
  }

  function hintBox(hints) {
    var box = document.createElement("div");
    box.className = "hint";
    box.innerHTML = hints.map(function (h) { return "<p>" + h + "</p>"; }).join("");
    return box;
  }

  function renderError(message, sql, someRan) {
    var box = document.createElement("div");
    box.className = "error-box";
    box.innerHTML = "<h3>Something isn't quite right</h3>" +
      (someRan ? "<p>The part of your query before the problem did run (see above).</p>" : "") +
      "<p>SQLite says:</p><p class=\"raw-error\">" + esc(message) + "</p>";
    var hints = getHints(message, sql);
    if (hints.length) box.appendChild(hintBox(hints));
    resultsEl.appendChild(box);
  }

  // ---------- Copy for case notebook ----------

  function textTable(block) {
    var cells = block.rows.map(function (r) {
      return r.map(function (v) { return v === null ? "NULL" : String(v).replace(/\s*\n\s*/g, " "); });
    });
    var widths = block.columns.map(function (c, i) {
      return cells.reduce(function (w, r) { return Math.max(w, r[i].length); }, c.length);
    });
    function line(values) {
      return values.map(function (v, i) { return v + " ".repeat(widths[i] - v.length); }).join(" | ").replace(/\s+$/, "");
    }
    var out = [line(block.columns), widths.map(function (w) { return "-".repeat(w); }).join("-+-")];
    cells.forEach(function (r) { out.push(line(r)); });
    return out.join("\n");
  }

  function notebookText(run) {
    var parts = ["QUERY:", run.sql.trim(), ""];
    run.blocks.forEach(function (b) {
      if (!b.columns) { parts.push("RESULT: " + b.message, ""); return; }
      var head = "RESULT: " + countText(b);
      if (b.count > b.rows.length) head += " (first " + plural(b.rows.length, "row") + " shown)";
      parts.push(head, textTable(b), "");
    });
    if (run.error) parts.push("ERROR: " + run.error, "");
    return parts.join("\n");
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { resolve(); } else { reject(new Error("copy failed")); }
    });
  }

  function copyForNotebook() {
    if (!lastRun) return;
    copyText(notebookText(lastRun)).then(function () {
      setStatus("Copied your query and results. Paste them into your case notebook.", "ok");
    }, function () {
      setStatus("Sorry, your browser blocked copying. Select the query and results with your mouse and copy them instead.", "error");
    });
  }

  // ---------- Tables panel ----------

  function putInEditor(text) {
    editor.focus();
    editor.select();
    // insertText keeps the browser's undo history, so Ctrl+Z brings the old query back.
    var ok = false;
    try { ok = document.execCommand("insertText", false, text); } catch (e) { ok = false; }
    if (!ok || editor.value !== text) editor.value = text;
    saveQuery();
  }

  function buildTablePanel() {
    TABLE_NAMES.forEach(function (t) {
      var li = document.createElement("li");
      var detailId = "table-detail-" + t;

      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "table-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-controls", detailId);
      toggle.innerHTML = "<span>marlowe." + esc(t) + "</span><span class=\"arrow\" aria-hidden=\"true\">▶</span>";

      var detail = document.createElement("div");
      detail.className = "table-detail";
      detail.id = detailId;
      detail.hidden = true;

      var count = document.createElement("p");
      count.className = "row-count";
      count.textContent = plural(DATA[t].rows.length, "row") + ". Columns:";
      detail.appendChild(count);

      var cols = document.createElement("ul");
      cols.className = "column-list";
      DATA[t].columns.forEach(function (c) {
        var item = document.createElement("li");
        item.innerHTML = "<span>" + esc(c) + "</span><span class=\"col-type\">" + columnType(t, c) + "</span>";
        cols.appendChild(item);
      });
      detail.appendChild(cols);

      var tryBtn = document.createElement("button");
      tryBtn.type = "button";
      tryBtn.className = "btn btn-small";
      tryBtn.textContent = "Put a sample query in the box";
      tryBtn.setAttribute("aria-label", "Put SELECT * FROM marlowe." + t + " LIMIT 10 in the query box");
      tryBtn.addEventListener("click", function () {
        putInEditor("SELECT * FROM marlowe." + t + " LIMIT 10;");
      });
      detail.appendChild(tryBtn);

      toggle.addEventListener("click", function () {
        var open = toggle.getAttribute("aria-expanded") === "true";
        toggle.setAttribute("aria-expanded", String(!open));
        detail.hidden = open;
      });

      li.appendChild(toggle);
      li.appendChild(detail);
      tableListEl.appendChild(li);
    });
  }

  // ---------- Start up ----------

  function resetData() {
    if (!SQL) return;
    if (db) db.close();
    db = buildDatabase();
    resultsEl.innerHTML = "";
    setStatus("All the data has been reset to the original case files.", "ok");
  }

  editor.value = loadSavedQuery();
  var saveTimer = null;
  editor.addEventListener("input", function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveQuery, 300);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      runQuery();
    }
  });
  runBtn.addEventListener("click", runQuery);
  copyBtn.addEventListener("click", copyForNotebook);
  resetBtn.addEventListener("click", resetData);

  if (!DATA) {
    setStatus("The case data file didn't load. Try refreshing the page.", "error");
    return;
  }
  buildTablePanel();

  if (typeof window.initSqlJs !== "function") {
    setStatus("The database engine couldn't load. Check your internet connection, then refresh the page.", "error");
    return;
  }

  window.initSqlJs({ locateFile: function (file) { return SQLJS_CDN + file; } }).then(function (lib) {
    SQL = lib;
    db = buildDatabase();
    runBtn.disabled = false;
    resetBtn.disabled = false;
    setStatus("Case database ready. Write a query and press Run query.", "ok");
  }).catch(function (err) {
    setStatus("The database engine couldn't start (" + (err && err.message ? err.message : err) +
      "). Check your internet connection, then refresh the page.", "error");
  });
})();
