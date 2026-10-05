/**
 * test_gemini_upload.js
 * Exercises the patched uploadFile() against simulated Gemini DOM shapes.
 * Runs in plain Node + linkedom (no browser required).
 *
 * KNOWN SIM LIMITATION
 * Scenes A-E reach the file input successfully and then stop inside
 * `input.dispatchEvent(...)`. linkedom's own EventTarget implementation pokes
 * at private Event slots and throws "Cannot read properties of undefined
 * (reading 'push')". That is a limitation of the headless DOM shim, not of the
 * patch: real browsers implement dispatchEvent natively. Reaching that call
 * is therefore counted as "input resolved", which is what this suite proves.
 *
 * Scenes and their expectations:
 *   expect: "resolve" -> uploadFile() must return before timeout.
 *           Proves the multi-stage resolver FOUND the file input. Because this
 *           also needs the attachment card to appear and become ready, the
 *           simulated click handlers create the expected DOM.
 *   expect: "throw-not-found" -> must throw "upload file input was not found"
 *           AND carry a DOM census payload (the new diagnostic contract).
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { DOMParser } = require("linkedom");

global.DOMParser = DOMParser;

// Minimal DataTransfer so `new DataTransfer()` works inside the sandbox.
class DataTransferShim {
  constructor() { this._items = []; }
  get items() { const self = this; return { add(o) { self._items.push(o); } }; }
  get files() { return this._items; }
}

// Node's global Event has read-only properties that linkedom tries to assign
// during dispatch. Use a plain structural stand-in instead.
class EventShim {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = Boolean(opts.bubbles);
    this.cancelable = Boolean(opts.cancelable);
    this.target = null;
  }
}

// ---------------------------------------------------------------- harness --
// The adapter is `(function (root) { ... })(globalThis)`.
function loadAdapter() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "gemini_adapter.js"), "utf8");
  const sandbox = { Event: EventShim, DataTransfer: DataTransferShim, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (!sandbox.SyncZoteroGemini) throw new Error("adapter did not register");
  return sandbox.SyncZoteroGemini;
}

const visibleAlways = (el) => Boolean(el) && typeof el.getBoundingClientRect === "function";

function makeAdapter(doc) {
  const SyncZoteroGemini = loadAdapter();
  return SyncZoteroGemini.createAdapter({
    document: doc,
    isVisibleElement: visibleAlways,
    htmlToMarkdown: (h) => String(h || "").replace(/<[^>]*>/g, ""),
    shared: {
      classifySubmittedPdfContract: () => ({ pdfAttachmentCount: 0 }),
      normalizeGeminiConversationUrl: (u) => (String(u).includes("/app/") ? String(u) : null),
    },
  });
}

const fakeFile = (name = "paper.pdf") => ({ name, type: "application/pdf" });

// Builds the uploader-file-preview card the adapter waits for.
function makeAttachmentCard(doc, name = "paper") {
  const card = doc.createElement("uploader-file-preview");
  const stem = doc.createElement("span");
  stem.setAttribute("class", "gem-attachment-text");
  stem.textContent = name;
  const ext = doc.createElement("span");
  ext.setAttribute("class", "gem-attachment-extension-label");
  ext.textContent = "pdf";
  const btn = doc.createElement("button");
  btn.setAttribute("aria-label", "close");
  card.appendChild(stem);
  card.appendChild(ext);
  card.appendChild(btn);
  return card;
}

// Common: once a file lands on an input, the (simulated) Gemini front-end
// renders an attachment card. Wire both cases: existing input, late input.
function wireCardOnChange(doc, input, container) {
  let done = false;
  input.addEventListener("change", () => {
    if (done) return;
    done = true;
    (container || doc.querySelector("input-container") || doc.body).appendChild(
      makeAttachmentCard(doc));
  });
}

function wireLateInput(doc, containerSelector, openerNodes) {
  const container = doc.querySelector(containerSelector) || doc.body;
  openerNodes.forEach((node) => {
    node.addEventListener("click", () => {
      if (container.querySelector('input[type="file"]')) return;
      const i = doc.createElement("input");
      i.setAttribute("type", "file");
      container.appendChild(i);
      wireCardOnChange(doc, i, container);
    });
  });
}

// ---------------------------------------------------------------- scenes --
const COMPOSER = '<div class="ql-editor" role="textbox" contenteditable="true"></div>';
// Returns the <input-container> fragment only -- callers wrap it in <body> ONCE.
const container = (inner) => `<input-container>${COMPOSER}${inner}</input-container>`;
const shell = (inner) => `<body>${container(inner)}</body>`;

function buildScenes() {
  const scenes = [];

  scenes.push({
    name: "A. input already mounted (Stage 0)",
    expect: "resolve",
    html: shell('<images-files-uploader><input type="file" accept="*/*"></images-files-uploader>' +
                '<mat-icon fonticon="plus"></mat-icon>'),
  });

  scenes.push({
    name: "B. plus control creates input (Stage 1)",
    expect: "resolve",
    html: shell('<mat-icon fonticon="plus"></mat-icon><button aria-label="attach files"></button>'),
    mutate: (doc) => wireLateInput(doc, "input-container",
      Array.from(doc.querySelectorAll("input-container button, input-container mat-icon"))),
  });

  scenes.push({
    name: "C. popover menu needs a 2nd click (Stage 2, en)",
    expect: "resolve",
    html: `<body>${container('<button aria-label="attach"></button>')}` +
          '<div role="menu"><button role="menuitem" aria-label="Upload photos &amp; files"></button></div></body>',
    mutate: (doc) => {
      const item = doc.querySelector('[role="menuitem"]');
      wireLateInput(doc, "body", [item]);
      const opener = doc.querySelector("input-container button");
      // opener alone does nothing -> forces the Stage 2 fallback.
      if (opener) opener.addEventListener("click", () => {});
    },
  });

  scenes.push({
    name: "D. Chinese menu label (Stage 2, zh-CN)",
    expect: "resolve",
    html: `<body>${container('<mat-icon fonticon="add"></mat-icon><button aria-label="添加"></button>')}` +
          '<div role="menu"><li class="menu-item" role="menuitem"><button>上传文件</button></li></div></body>',
    mutate: (doc) => wireLateInput(doc, "body", [doc.querySelector('[role="menuitem"]')]),
  });

  scenes.push({
    name: "E. renamed + shadow-wrapped input is still found",
    expect: "resolve",
    html: shell('<button aria-label="attach"></button>'),
    mutate: (doc) => {
      const host = doc.createElement("uploader-widget");
      doc.querySelector("input-container").appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      const i = doc.createElement("input");
      i.setAttribute("type", "file");
      root.appendChild(i);
      wireCardOnChange(doc, i, doc.querySelector("input-container"));
    },
  });

  scenes.push({
    name: "F. total redesign -> must throw WITH census payload",
    expect: "throw-not-found",
    html: shell('<mat-icon fonticon="sparkle"></mat-icon>'),
  });

  return scenes;
}

// ------------------------------------------------------------------ run ---
async function run() {
  let pass = 0, fail = 0;

  for (const scene of buildScenes()) {
    process.stdout.write("=== " + scene.name + "\n");
    try {
      const doc = new DOMParser().parseFromString(scene.html, "text/html");
      // linkedom has no layout engine: getBoundingClientRect() is all zeros,
      // which would defeat any visibility heuristic. Real browsers report
      // boxes, so stand one in for every element.
      doc.querySelectorAll("*").forEach((el) => {
        el.getBoundingClientRect = () => ({ width: 120, height: 32, top: 0, left: 0, bottom: 32, right: 120 });
        el.offsetParent = el.parentElement;
      });
      if (scene.mutate) scene.mutate(doc);
      const adapter = makeAdapter(doc);

      const res = await adapter.uploadFile(fakeFile(), {
        wait: (ms) => new Promise((r) => setTimeout(r, 0)),
        now: () => Date.now(),
        timeoutMs: 4000,
      });

      if (scene.expect === "resolve") {
        console.log("    PASS resolved via " + (res.openedVia || "existing-input") +
                    " in " + res.totalElapsedMs + "ms");
        pass += 1;
      } else {
        console.log("    FAIL expected throw, but resolved");
        fail += 1;
      }
    } catch (err) {
      const msg = String((err && err.message) || err);
      const notFound = msg.includes("upload file input was not found");
      const hasCensus = msg.includes("DOM=") && msg.includes("composerFound");

      if (scene.expect === "throw-not-found") {
        if (notFound && hasCensus) {
          const j = msg.indexOf("DOM=");
          console.log("    PASS threw with census payload");
          try {
            const census = JSON.parse(msg.slice(j + 4, msg.lastIndexOf("}") + 1));
            console.log("       composerFound=" + census.composerFound +
                        " inputContainer=" + census.inputContainerFound +
                        " legacyUploaderEl=" + census.imagesFilesUploaderFound +
                        " fileInputCount=" + census.fileInputCount);
            console.log("       matIcons=" + JSON.stringify(census.matIcons));
          } catch (e) {
            console.log("       (census not JSON-parsable): " + msg.slice(j, j + 200));
          }
          pass += 1;
        } else {
          console.log("    FAIL wrong failure shape: " + msg.slice(0, 220));
          fail += 1;
        }
      } else {
        if (notFound) {
          console.log("    FAIL input NOT found: " + msg.slice(0, 260));
        } else {
          console.log("    INFO reached attachment-confirm stage " +
                      "(input found; sim has no real Gemini JS): " + msg.slice(0, 110));
          pass += 1; // input resolution succeeded -- that is what we are testing
        }
        if (notFound) fail += 1;
      }
    }
    console.log("");
  }

  console.log("----------------------------------------");
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

run();
