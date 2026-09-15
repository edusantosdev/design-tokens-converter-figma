// Design Tokens Converter
// Scans auto-layout nodes for raw (unbound) spacing values and offers to
// bind them to matching semantic spacing tokens from an external team library.

const SPACING_FIELDS = [
  "itemSpacing",
  "counterAxisSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
];

// ---- Library listing -------------------------------------------------------

/**
 * List every variable collection from every team library enabled for this
 * file. The UI then keeps only libraries that contain an exact "Spacing"
 * collection and uses that collection automatically.
 */
async function listLibraries() {
  const libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  return libraryCollections.map((c) => ({
    key: c.key,
    name: c.name,
    libraryName: c.libraryName,
  }));
}

// ---- Token loading -------------------------------------------------------

/**
 * Pull spacing-scoped FLOAT variables from the specific library collections
 * the user picked in the UI (by collection key). Resolves each token down
 * to a plain px number by walking alias chains, since semantic tokens
 * usually just point at core tokens rather than holding a literal value.
 */
async function loadSpacingTokens(collectionKeys) {
  const libraryCollections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  const selectedKeys = new Set(collectionKeys || []);
  const targetCollections = libraryCollections.filter((c) => selectedKeys.has(c.key));

  const tokens = [];
  for (const col of targetCollections) {
    let libVars;
    try {
      libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
    } catch (e) {
      continue; // library not accessible / not enabled
    }

    for (const libVar of libVars) {
      if (cancelRequested) return tokens;
      if (libVar.resolvedType !== "FLOAT") continue;

      const imported = await figma.variables.importVariableByKeyAsync(libVar.key);

      // Only consider tokens actually scoped for spacing usage.
      const scopes = imported.scopes || [];
      if (!scopes.includes("GAP") && !scopes.includes("ALL_SCOPES")) continue;

      const value = await resolveNumericValue(imported);
      if (value == null) continue;

      tokens.push({
        id: imported.id,
        name: imported.name,
        value,
        collection: col.name,
      });
    }
  }
  return tokens;
}

/** Follow VARIABLE_ALIAS chains down to a literal number, for the
 *  collection's default mode. Returns null if it can't resolve. */
async function resolveNumericValue(variable, depth) {
  depth = depth || 0;
  if (depth > 6) return null;

  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId
  );
  if (!collection) return null;

  const modeId = collection.defaultModeId;
  const raw = variable.valuesByMode[modeId];
  if (raw == null) return null;

  if (typeof raw === "number") return raw;

  if (typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
    const aliased = await figma.variables.getVariableByIdAsync(raw.id);
    if (!aliased) return null;
    return resolveNumericValue(aliased, depth + 1);
  }

  return null;
}

function buildValueMap(tokens) {
  const map = new Map();
  for (const t of tokens) {
    if (!map.has(t.value)) map.set(t.value, []);
    map.get(t.value).push(t);
  }
  return map;
}

// ---- Node scanning --------------------------------------------------------

function isAutoLayout(node) {
  return "layoutMode" in node && node.layoutMode !== "NONE";
}

function collectAutoLayoutNodes(root) {
  if ("findAll" in root) {
    const found = root.findAll((n) => isAutoLayout(n));
    if (isAutoLayout(root)) found.unshift(root);
    return found;
  }
  return isAutoLayout(root) ? [root] : [];
}

function getUnboundSpacingProps(node) {
  const results = [];
  for (const field of SPACING_FIELDS) {
    if (!(field in node)) continue;
    const value = node[field];
    if (typeof value !== "number" || value === 0) continue; // skip zero, low-signal
    const alreadyBound = node.boundVariables && node.boundVariables[field];
    if (alreadyBound) continue;
    results.push({ field, value });
  }
  return results;
}

async function scan(msg) {
  cancelRequested = false;
  if (!msg.collectionKeys || msg.collectionKeys.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message: "Select at least one library collection before scanning.",
    });
    return;
  }

  const tokens = await loadSpacingTokens(msg.collectionKeys);
  if (cancelRequested) {
    figma.ui.postMessage({ type: "scan-cancelled" });
    return;
  }
  const valueMap = buildValueMap(tokens);

  let roots;
  if (msg.scope === "selection" && figma.currentPage.selection.length > 0) {
    roots = figma.currentPage.selection;
  } else {
    roots = [figma.currentPage];
  }

  let nodes = [];
  for (const r of roots) nodes = nodes.concat(collectAutoLayoutNodes(r));

  // Group by (field, value) rather than emitting one row per node. The
  // token match only depends on the field+value pair, so a page with
  // 65,000 raw spacing occurrences usually collapses into a few dozen
  // groups — reviewable in the UI, and appliable as one bulk operation
  // per group instead of tens of thousands of individual lookups.
  const groups = new Map();
  let rawValueCount = 0;
  let sliceStart = Date.now();
  for (const node of nodes) {
    if (cancelRequested) {
      figma.ui.postMessage({ type: "scan-cancelled" });
      return;
    }
    for (const prop of getUnboundSpacingProps(node)) {
      const key = prop.field + "|" + prop.value;
      let group = groups.get(key);
      if (!group) {
        group = { field: prop.field, value: prop.value, nodes: [] };
        groups.set(key, group);
      }
      group.nodes.push(node);
      rawValueCount++;
    }

    // Yield periodically (time-sliced, not a fixed node count) so Figma's
    // plugin watchdog doesn't consider the UI thread stuck on huge scopes.
    if (Date.now() - sliceStart > 16) {
      await yieldToUI();
      sliceStart = Date.now();
    }
  }

  // Cache the actual node references, keyed the same way, so `apply` can
  // bind directly without re-fetching every node by id.
  lastScanGroups = groups;

  const summary = [];
  for (const [key, group] of groups) {
    const matches = valueMap.get(group.value) || [];
    summary.push({
      key,
      field: group.field,
      value: group.value,
      count: group.nodes.length,
      matches: matches.map((m) => ({ id: m.id, name: m.name, collection: m.collection })),
    });
  }
  summary.sort((a, b) => (a.field === b.field ? a.value - b.value : a.field.localeCompare(b.field)));

  figma.ui.postMessage({
    type: "scan-result",
    groups: summary,
    tokens: tokens.map((t) => ({
      id: t.id,
      name: t.name,
      collection: t.collection,
      value: t.value,
    })),
    tokenCount: tokens.length,
    scannedNodeCount: nodes.length,
    rawValueCount,
  });
}

// ---- Applying ---------------------------------------------------------

let lastScanGroups = new Map(); // key ("field|value") -> { field, value, nodes: Node[] }
let cancelRequested = false;

function yieldToUI() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * selections: [{ key, variableId }] — one entry per group the user kept
 * checked, with the token they picked (or the default top match).
 * Node references come from the cache built during the most recent scan,
 * so this never re-fetches nodes by id, and variables are resolved once
 * per unique id rather than once per node.
 *
 * Yields are time-sliced (roughly every ~16ms of work) rather than every
 * N nodes, because setBoundVariable's actual cost per call can vary a lot
 * with document size/undo history — a fixed node count can still block
 * the thread for a long, visible stretch if each call happens to be slow.
 */
async function apply(selections) {
  cancelRequested = false;
  let successNodes = 0;
  let failedNodes = 0;
  let missingGroups = 0;
  let cancelled = false;
  const variableCache = new Map();

  async function getVariableCached(variableId) {
    if (variableCache.has(variableId)) return variableCache.get(variableId);
    const v = await figma.variables.getVariableByIdAsync(variableId);
    variableCache.set(variableId, v);
    return v;
  }

  let processedNodes = 0;
  const totalNodes = selections.reduce((sum, sel) => {
    const g = lastScanGroups.get(sel.key);
    return sum + (g ? g.nodes.length : 0);
  }, 0);

  let sliceStart = Date.now();

  outer: for (const sel of selections) {
    const group = lastScanGroups.get(sel.key);
    if (!group) {
      missingGroups++;
      continue;
    }
    const variable = await getVariableCached(sel.variableId);
    if (!variable) {
      failedNodes += group.nodes.length;
      continue;
    }

    for (const node of group.nodes) {
      if (cancelRequested) {
        cancelled = true;
        break outer;
      }
      try {
        node.setBoundVariable(group.field, variable);
        successNodes++;
      } catch (e) {
        failedNodes++;
      }
      processedNodes++;

      if (Date.now() - sliceStart > 16) {
        figma.ui.postMessage({ type: "apply-progress", done: processedNodes, total: totalNodes });
        await yieldToUI();
        sliceStart = Date.now();
      }
    }
  }

  figma.ui.postMessage({ type: "apply-result", successNodes, failedNodes, missingGroups, cancelled });
}

// ---- Bootstrap ----------------------------------------------------------

figma.showUI(__html__, { width: 720, height: 680, themeColors: true });

async function sendLibraries() {
  try {
    const libraries = await listLibraries();
    figma.ui.postMessage({ type: "libraries", libraries });
  } catch (e) {
    figma.ui.postMessage({
      type: "error",
      message: "Couldn't load team libraries: " + String(e && e.message ? e.message : e),
    });
  }
}

// Send the library list as soon as the UI is ready.
sendLibraries();

figma.ui.onmessage = async (msg) => {
  if (msg.type === "scan") {
    try {
      await scan(msg);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "apply") {
    await apply(msg.selections);
  } else if (msg.type === "cancel" || msg.type === "cancel-apply") {
    cancelRequested = true;
  } else if (msg.type === "refresh-libraries") {
    await sendLibraries();
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
