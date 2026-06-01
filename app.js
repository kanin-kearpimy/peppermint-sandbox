const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");
const uploadBtn = document.getElementById("uploadBtn");
const clearBtn = document.getElementById("clearBtn");
const textViewBtn = document.getElementById("textViewBtn");
// const tableViewBtn = document.getElementById("tableViewBtn");
const editorEl = document.getElementById("editor");
const outputEl = document.getElementById("output");
const outputTableWrapEl = document.getElementById("outputTableWrap");
const outputTableEl = document.getElementById("outputTable");
const tableMetaEl = document.getElementById("tableMeta");
const csvInput = document.getElementById("csvInput");
const uploadSummaryEl = document.getElementById("uploadSummary");
const uploadedFilesListEl = document.getElementById("uploadedFilesList");

let pyodide;
const uploadedFiles = [];
let outputMode = "text";
let lastExecutionValue;

const INSTALL_PEPPERMINT_SCRIPT = `
import micropip

await micropip.install("peppermint-lang @ https://github.com/chayapatr/peppermint/archive/refs/heads/main.zip")
`;

const RUN_PEPPERMINT_SCRIPT = `
from peppermint.parser import parse
from peppermint.interpreter import Interpreter
from peppermint.stdlib import build_global_env

program = parse(peppermint_source)
interpreter = Interpreter(build_global_env(), quiet=True)
result = interpreter.run(program)
result
`;

function setStatus(text, type = "muted") {
  statusEl.textContent = text;
  statusEl.classList.remove("output-error", "output-ok");
  if (type === "error") {
    statusEl.classList.add("output-error");
  }
  if (type === "ok") {
    statusEl.classList.add("output-ok");
  }
}

function writeOutput(text, kind = "") {
  outputEl.textContent = text;
  outputEl.classList.remove("output-error", "output-ok");
  if (kind) {
    outputEl.classList.add(kind);
  }
}

function formatForOutput(value) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function normalizePythonResult(result) {
  if (result && typeof result.toJs === "function") {
    const converted = result.toJs({ dict_converter: Object.fromEntries });
    if (typeof result.destroy === "function") {
      result.destroy();
    }
    return converted;
  }

  return result;
}

function setOutputMode(mode) {
  outputMode = mode;
  const isText = mode === "text";

  outputEl.classList.toggle("hidden", !isText);
  outputTableWrapEl.classList.toggle("hidden", isText);
  textViewBtn.classList.toggle("active", isText);
//   tableViewBtn.classList.toggle("active", !isText);

  if (!isText) {
    renderTableView();
  }
}

function setTableMeta(text, kind = "") {
  tableMetaEl.textContent = text;
  tableMetaEl.classList.remove("output-error", "output-ok");
  if (kind) {
    tableMetaEl.classList.add(kind);
  }
}

function renderHtmlTable(columns, rows) {
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = String(column);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cell === null || cell === undefined ? "" : String(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  outputTableEl.replaceChildren(thead, tbody);
}

async function renderTableView() {
  if (outputMode !== "table") {
    return;
  }

  if (!Array.isArray(lastExecutionValue)) {
    outputTableEl.replaceChildren();
    setTableMeta("Not Compatible", "output-error");
    return;
  }

  const arr = lastExecutionValue;
  if (arr.length === 0) {
    outputTableEl.replaceChildren();
    setTableMeta("Array output is empty (0 rows)", "output-ok");
    return;
  }

  let columns = [];
  let rows = [];

  const isObjectArray = arr.every((item) => item && typeof item === "object" && !Array.isArray(item));
  const isArrayArray = arr.every((item) => Array.isArray(item));

  if (isObjectArray) {
    columns = [...new Set(arr.flatMap((row) => Object.keys(row)))];
    rows = arr.map((row) => columns.map((col) => row[col]));
  } else if (isArrayArray) {
    const maxLen = Math.max(...arr.map((row) => row.length));
    columns = Array.from({ length: maxLen }, (_, idx) => String(idx));
    rows = arr;
  } else {
    columns = ["value"];
    rows = arr.map((value) => [value]);
  }

  renderHtmlTable(columns, rows);
  setTableMeta(`rows: ${rows.length}, columns: ${columns.length}`, "output-ok");
}

function renderUploadedFiles() {
  uploadedFilesListEl.innerHTML = "";

  if (!uploadedFiles.length) {
    uploadSummaryEl.textContent = "No files uploaded yet";
    return;
  }

  uploadSummaryEl.textContent = `${uploadedFiles.length} file(s) uploaded`;

  for (const fileInfo of uploadedFiles) {
    const item = document.createElement("li");
    item.className = "meta-item";

    const name = document.createElement("p");
    name.className = "uploaded-file-name";
    name.textContent = fileInfo.name;

    const path = document.createElement("p");
    path.className = "uploaded-file-path";
    path.textContent = fileInfo.path;

    item.append(name, path);
    uploadedFilesListEl.appendChild(item);
  }
}

function syncUploadedPathsToRuntime() {
  const paths = uploadedFiles.map((item) => item.path);
  const lastPath = paths.length ? paths[paths.length - 1] : "";

  pyodide.globals.set("uploaded_csv_path", lastPath);
  pyodide.globals.set("uploaded_csv_paths_json", JSON.stringify(paths));
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function buildUniqueFsPath(fsDir, safeName) {
  const dotIndex = safeName.lastIndexOf(".");
  const base = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
  const ext = dotIndex > 0 ? safeName.slice(dotIndex) : "";
  let counter = 0;

  while (true) {
    const suffix = counter === 0 ? "" : `_${counter}`;
    const candidate = `${fsDir}/${base}${suffix}${ext}`;
    if (!pyodide.FS.analyzePath(candidate).exists) {
      return candidate;
    }
    counter += 1;
  }
}

async function uploadCsvFiles(files) {
  if (!pyodide) {
    writeOutput("Runtime is not ready yet.", "output-error");
    return;
  }

  if (!files.length) {
    return;
  }

  setStatus("Uploading CSV...", "muted");
  uploadBtn.disabled = true;

  try {
    const fsDir = "/uploads";

    if (!pyodide.FS.analyzePath(fsDir).exists) {
      pyodide.FS.mkdir(fsDir);
    }

    for (const file of files) {
      const csvText = await file.text();
      const safeName = sanitizeFilename(file.name || "data.csv");
      const fsPath = buildUniqueFsPath(fsDir, safeName);

      pyodide.FS.writeFile(fsPath, csvText, { encoding: "utf8" });
      uploadedFiles.push({ name: safeName, path: fsPath });
    }

    syncUploadedPathsToRuntime();
    renderUploadedFiles();

    const lastUploaded = uploadedFiles[uploadedFiles.length - 1];
    writeOutput(`Uploaded ${files.length} CSV file(s). Last file path: ${lastUploaded.path}`, "output-ok");
    setStatus("CSV uploaded", "ok");
  } catch (error) {
    writeOutput(String(error), "output-error");
    setStatus("CSV upload failed", "error");
  } finally {
    uploadBtn.disabled = false;
    csvInput.value = "";
  }
}

async function initializePyodide() {
  try {
    pyodide = await loadPyodide();
    setStatus("Installing Peppermint...", "muted");
    await pyodide.loadPackage("pandas");
    await pyodide.loadPackage("micropip");
    await pyodide.runPythonAsync(INSTALL_PEPPERMINT_SCRIPT);
    setStatus("Pyodide + Peppermint ready", "ok");
    runBtn.disabled = false;
    uploadBtn.disabled = false;
  } catch (error) {
    setStatus("Failed to initialize runtime", "error");
    writeOutput(String(error), "output-error");
  }
}

async function runPeppermintCode() {
  if (!pyodide) {
    writeOutput("Runtime is not ready yet.", "output-error");
    return;
  }

  setOutputMode("text");

  const source = editorEl.value;
  const stdout = [];
  const stderr = [];

  runBtn.disabled = true;
  setStatus("Running...", "muted");

  pyodide.setStdout({
    batched: (msg) => stdout.push(msg),
  });
  pyodide.setStderr({
    batched: (msg) => stderr.push(msg),
  });

  try {
    pyodide.globals.set("peppermint_source", source);
    const result = normalizePythonResult(await pyodide.runPythonAsync(RUN_PEPPERMINT_SCRIPT));
    lastExecutionValue = result;
    const outputParts = [];

    if (stdout.length) {
      outputParts.push(stdout.join("\n"));
    }

    if (result !== undefined && result !== null) {
      outputParts.push(formatForOutput(result));
    }

    if (stderr.length) {
      outputParts.push("\n[stderr]\n" + stderr.join("\n"));
    }

    writeOutput(outputParts.join("\n") || "(No output)", stderr.length ? "output-error" : "output-ok");
    setStatus("Execution complete", stderr.length ? "error" : "ok");
  } catch (error) {
    lastExecutionValue = undefined;
    writeOutput(String(error), "output-error");
    setStatus("Execution failed", "error");
  } finally {
    pyodide.globals.delete("peppermint_source");
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", runPeppermintCode);
uploadBtn.addEventListener("click", () => csvInput.click());
textViewBtn.addEventListener("click", () => setOutputMode("text"));
// tableViewBtn.addEventListener("click", () => setOutputMode("table"));
csvInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []);
  await uploadCsvFiles(files);
});
clearBtn.addEventListener("click", () => {
  if (outputMode === "text") {
    writeOutput("Waiting for code execution...");
    return;
  }

  outputTableEl.replaceChildren();
  setTableMeta("Not Compatible", "output-error");
});

renderUploadedFiles();
setOutputMode("text");
initializePyodide();
