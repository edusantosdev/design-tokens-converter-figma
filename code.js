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
function scopesAllow(scopes, wanted) {
  const list = scopes || [];
  if (list.includes("ALL_SCOPES")) return true;
  return wanted.some((scope) => list.includes(scope));
}

async function loadScopedTokens(collectionKeys, wantedScopes) {
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
      if (!scopesAllow(imported.scopes, wantedScopes)) continue;

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

async function loadSpacingTokens(collectionKeys) {
  return loadScopedTokens(collectionKeys, ["GAP"]);
}

async function loadRadiusTokens(collectionKeys) {
  const tokens = [];
  const seen = new Set();

  function add(token) {
    if (!token || seen.has(token.id)) return;
    seen.add(token.id);
    tokens.push(token);
  }

  if (collectionKeys && collectionKeys.length) {
    const libraryTokens = await loadScopedTokens(collectionKeys, ["CORNER_RADIUS"]);
    libraryTokens.forEach(add);
  }

  let locals = [];
  try {
    locals = await figma.variables.getLocalVariablesAsync("FLOAT");
  } catch (e) {
    locals = [];
  }
  for (const variable of locals) {
    if (cancelRequested) return tokens;
    if (!scopesAllow(variable.scopes, ["CORNER_RADIUS"])) continue;
    const value = await resolveNumericValue(variable);
    if (value == null) continue;
    const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
    add({
      id: variable.id,
      name: variable.name,
      value,
      collection: collection ? collection.name : "Local",
    });
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
  lastLocated = null;
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

// ---- Inspect / locate -------------------------------------------------

function liveNodes(group) {
  if (!group) return [];
  const live = group.nodes.filter((n) => n && !n.removed);
  if (live.length !== group.nodes.length) group.nodes = live;
  return live;
}

function ancestorPath(node, maxParts) {
  const parts = [];
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    parts.unshift(current.name || current.type);
    current = current.parent;
    if (parts.length >= maxParts) {
      if (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
        parts[0] = "…";
      }
      break;
    }
  }
  return parts.join(" › ");
}

async function ensureNodePage(node) {
  let page = node.parent;
  while (page && page.type !== "PAGE") page = page.parent;
  if (page && page !== figma.currentPage) {
    await figma.setCurrentPageAsync(page);
  }
}

function locatePayload(node, key, index, total, extra) {
  return Object.assign(
    {
      type: "locate-result",
      key,
      index,
      total,
      name: node.name,
      nodeType: node.type,
      path: ancestorPath(node, 6),
    },
    extra || {}
  );
}

async function revealNode(node) {
  await ensureNodePage(node);
  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
}

async function locate(msg) {
  const group = lastScanGroups.get(msg.key);
  const nodes = liveNodes(group);
  if (nodes.length === 0) {
    lastLocated = null;
    figma.ui.postMessage({
      type: "locate-result",
      key: msg.key,
      index: 0,
      total: 0,
      error: "No nodes left in this group.",
    });
    return;
  }
  const index = ((msg.index % nodes.length) + nodes.length) % nodes.length;
  const node = nodes[index];
  lastLocated = { key: msg.key, index, node };
  await revealNode(node);
  figma.notify((index + 1) + " / " + nodes.length + " · " + (node.name || node.type), { timeout: 2000 });
  figma.ui.postMessage(locatePayload(node, msg.key, index, nodes.length));
}

async function skipLocated() {
  if (!lastLocated) {
    figma.ui.postMessage({
      type: "locate-result",
      error: "Nothing to skip — locate a node first.",
    });
    return;
  }
  const skippedNode = lastLocated.node;
  const key = lastLocated.key;
  const emptied = [];
  const remaining = [];
  for (const [groupKey, group] of lastScanGroups) {
    const before = group.nodes.length;
    group.nodes = group.nodes.filter((n) => n !== skippedNode && n && !n.removed);
    if (group.nodes.length !== before) {
      if (group.nodes.length === 0) emptied.push(groupKey);
      else {
        const entry = { key: groupKey, total: group.nodes.length };
        if (group.fieldsByNode) entry.cornerCount = cornerCountFor(group);
        remaining.push(entry);
      }
    }
  }
  for (const emptyKey of emptied) lastScanGroups.delete(emptyKey);

  const group = lastScanGroups.get(key);
  const nodes = liveNodes(group);
  if (nodes.length === 0) {
    lastLocated = null;
    figma.ui.postMessage({
      type: "locate-result",
      key,
      index: 0,
      total: 0,
      skipped: true,
      emptiedKeys: emptied,
      remainingCounts: remaining,
    });
    return;
  }
  const index = Math.min(lastLocated.index, nodes.length - 1);
  const node = nodes[index];
  lastLocated = { key, index, node };
  await revealNode(node);
  figma.notify("Skipped · now " + (index + 1) + " / " + nodes.length + " · " + (node.name || node.type), { timeout: 2000 });
  figma.ui.postMessage(
    locatePayload(node, key, index, nodes.length, {
      skipped: true,
      emptiedKeys: emptied,
      remainingCounts: remaining,
    })
  );
}

function collectNodeAndAncestors(node) {
  const list = [];
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    list.push(current);
    current = current.parent;
  }
  return list;
}

async function inspectSelection() {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    figma.ui.postMessage({
      type: "locate-result",
      error: "Select a node on the canvas first, then click the crosshair.",
    });
    return;
  }
  if (lastScanGroups.size === 0) {
    figma.ui.postMessage({
      type: "locate-result",
      error: "Scan first, then inspect a node.",
    });
    return;
  }
  const candidates = collectNodeAndAncestors(selection[0]);
  const candidateIds = new Set(candidates.map((n) => n.id));
  const hits = [];
  for (const [key, group] of lastScanGroups) {
    const nodes = liveNodes(group);
    const index = nodes.findIndex((n) => candidateIds.has(n.id));
    if (index >= 0) {
      hits.push({ key, index, node: nodes[index], total: nodes.length });
    }
  }
  if (hits.length === 0) {
    figma.ui.postMessage({
      type: "locate-result",
      error: "That selection isn't in the current scan results.",
    });
    return;
  }
  hits.sort((a, b) => {
    const ai = candidates.findIndex((n) => n.id === a.node.id);
    const bi = candidates.findIndex((n) => n.id === b.node.id);
    return ai - bi;
  });
  const primary = hits[0];
  lastLocated = { key: primary.key, index: primary.index, node: primary.node };
  await revealNode(primary.node);
  figma.notify((primary.index + 1) + " / " + primary.total + " · " + (primary.node.name || primary.node.type), { timeout: 2000 });
  figma.ui.postMessage(
    locatePayload(primary.node, primary.key, primary.index, primary.total, {
      hits: hits.map((h) => ({ key: h.key, index: h.index })),
    })
  );
}

// ---- Radius remap -------------------------------------------------------
//
// Remaps corner radius on main components and variants using the mapping
// the UI sends (default 4→6 and 8→12). Each corner is decided on its own,
// so a mixed node keeps the corners that are not in the mapping.
// Instances are skipped unless "Overwrite instance values" is checked.
// Checking it writes overrides on those instances, including nested frames.
// Raw corners get the new number, or a token at that number when one is chosen.
// Corners already bound to a variable are rebound to a token, or written as a
// number when the user picks Raw number. That removes the variable.

const CORNER_FIELDS = [
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
];

// Figma occasionally stores 4.0000002. This catches that without treating
// 4.5, 0, or a pill radius as a match.
const RADIUS_EPSILON = 0.001;

function valueMatches(value, target) {
  return typeof value === "number" && isFinite(value) && Math.abs(value - target) < RADIUS_EPSILON;
}

function normalizeRadiusMappings(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { error: "Add at least one radius mapping." };
  }
  const mappings = [];
  const seen = new Set();
  for (const entry of list) {
    const from = Number(entry && entry.from);
    const to = Number(entry && entry.to);
    if (!isFinite(from) || !isFinite(to)) {
      return { error: "Each mapping needs a from and a to value." };
    }
    if (Math.abs(from - to) < RADIUS_EPSILON) {
      return { error: "From and to must be different." };
    }
    const key = String(Math.round(from * 1000) / 1000);
    if (seen.has(key)) {
      return { error: from + "px is mapped more than once." };
    }
    seen.add(key);
    mappings.push({ from, to });
  }
  return { mappings };
}

function mappedRadius(value, mappings) {
  if (typeof value !== "number" || !isFinite(value)) return null;
  for (const entry of mappings) {
    if (valueMatches(value, entry.from)) return entry;
  }
  return null;
}

function tokensAtValue(tokens, target) {
  return tokens
    .filter((token) => valueMatches(token.value, target))
    .map((token) => ({
      id: token.id,
      name: token.name,
      collection: token.collection,
      value: token.value,
    }));
}

function hasCornerFields(node) {
  return !!node && "topLeftRadius" in node && "bottomRightRadius" in node;
}

function isInsideInstance(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return true;
    current = current.parent;
  }
  return false;
}

function isInsideComponentSource(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return false;
    if (current.type === "COMPONENT") return true;
    current = current.parent;
  }
  return false;
}

function owningComponent(node) {
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.type === "INSTANCE") return null;
    if (current.type === "COMPONENT") return current;
    current = current.parent;
  }
  return null;
}

function normalizeExclusions(list) {
  const exclusions = [];
  const seen = new Set();
  const source = Array.isArray(list) ? list : [];
  for (const entry of source) {
    const text = String(entry == null ? "" : entry).trim().toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    exclusions.push(text);
  }
  return exclusions;
}

function nameMatchesExclusion(name, exclusions) {
  const text = String(name || "").toLowerCase();
  return exclusions.some((pattern) => text.indexOf(pattern) !== -1);
}

function nameMatchesExact(name, names) {
  const text = String(name || "").trim().toLowerCase();
  return !!text && names.some((pattern) => text === pattern);
}

async function instanceSourceNames(instance, cache) {
  if (cache.has(instance.id)) return cache.get(instance.id);
  const names = [];
  try {
    const main = await instance.getMainComponentAsync();
    if (main) {
      names.push(main.name || "");
      if (main.parent && main.parent.type === "COMPONENT_SET") names.push(main.parent.name || "");
    }
  } catch (e) {
    // Main component can live on a page that is not loaded.
  }
  cache.set(instance.id, names);
  return names;
}

async function excludedByName(node, exclusions, instanceCache) {
  if (!exclusions.length) return false;
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (current.type === "COMPONENT" || current.type === "COMPONENT_SET" || current.type === "INSTANCE") {
      if (nameMatchesExclusion(current.name, exclusions)) return true;
    }
    if (current.type === "INSTANCE") {
      const names = await instanceSourceNames(current, instanceCache);
      if (names.some((name) => nameMatchesExclusion(name, exclusions))) return true;
    }
    current = current.parent;
  }
  return false;
}

// Empty inclusions mean every layer in scope is eligible. A name matches the
// layer itself or any ancestor frame, group, component, or instance, including
// the main component and component set behind an instance.
async function includedByName(node, inclusions, instanceCache) {
  if (!inclusions.length) return true;
  let current = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if (nameMatchesExact(current.name, inclusions)) return true;
    if (current.type === "INSTANCE") {
      const names = await instanceSourceNames(current, instanceCache);
      if (names.some((name) => nameMatchesExact(name, inclusions))) return true;
    }
    current = current.parent;
  }
  return false;
}

function isCornerBound(node, field) {
  const bound = node.boundVariables;
  return !!(bound && bound[field]);
}

function radiusGroupKey(entry, bound) {
  return "radius|" + entry.from + "|" + entry.to + "|" + (bound ? "bound" : "raw");
}

function cornerCountFor(group) {
  if (!group || !group.fieldsByNode) return 0;
  let count = 0;
  for (const node of group.nodes) {
    const fields = group.fieldsByNode.get(node);
    if (fields) count += fields.length;
  }
  return count;
}

async function collectRadiusNodes(roots, onlyComponents, includeInstances) {
  const stack = [];
  let skippedInstances = 0;
  for (let i = roots.length - 1; i >= 0; i--) {
    const root = roots[i];
    if (!root) continue;
    const rootIsInstance = root.type === "INSTANCE" || isInsideInstance(root);
    if (rootIsInstance && !includeInstances) {
      skippedInstances++;
      continue;
    }
    stack.push({
      node: root,
      insideComponent: onlyComponents ? isInsideComponentSource(root) : true,
      insideInstance: rootIsInstance,
    });
  }

  const found = [];
  let sliceStart = Date.now();
  while (stack.length) {
    if (cancelRequested) return null;
    const item = stack.pop();
    const node = item.node;
    if (!node || node.removed) continue;

    const insideInstance = item.insideInstance || node.type === "INSTANCE";
    if (node.type === "INSTANCE" && !includeInstances) {
      skippedInstances++;
      continue;
    }

    const insideComponent = onlyComponents
      ? item.insideComponent || node.type === "COMPONENT"
      : true;
    const inScope = insideComponent || (includeInstances && insideInstance);
    if (inScope && hasCornerFields(node)) found.push(node);

    if ("children" in node) {
      const children = node.children;
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({
          node: children[i],
          insideComponent,
          insideInstance,
        });
      }
    }

    if (Date.now() - sliceStart > 16) {
      await yieldToUI();
      sliceStart = Date.now();
    }
  }
  return { nodes: found, skippedInstances };
}

async function scanRadius(msg) {
  cancelRequested = false;
  lastLocated = null;

  const parsed = normalizeRadiusMappings(msg.mappings);
  if (parsed.error) {
    figma.ui.postMessage({ type: "error", message: parsed.error });
    return;
  }
  const mappings = parsed.mappings;
  const exclusions = normalizeExclusions(msg.exclusions);
  const inclusions = normalizeExclusions(msg.inclusions);

  const selectionScope = msg.scope === "selection";
  if (selectionScope && figma.currentPage.selection.length === 0) {
    figma.ui.postMessage({
      type: "error",
      message: "Select a layer first, or switch scope to the whole page.",
    });
    return;
  }
  const roots = selectionScope ? figma.currentPage.selection : [figma.currentPage];

  const tokens = await loadRadiusTokens(msg.collectionKeys || []);
  if (cancelRequested) {
    figma.ui.postMessage({ type: "scan-cancelled" });
    return;
  }

  // Selection updates the layers you picked, including plain frames.
  // Whole page stays on main components, plus instances when overwrite is on.
  const collected = await collectRadiusNodes(roots, !selectionScope, !!msg.includeInstances);
  if (collected == null) {
    figma.ui.postMessage({ type: "scan-cancelled" });
    return;
  }
  const nodes = collected.nodes;

  const groups = new Map();
  let rawCorners = 0;
  let boundCorners = 0;
  let buttonCorners = 0;
  let excludedCorners = 0;
  let outsideIncludeCorners = 0;
  const instanceNameCache = new Map();
  let sliceStart = Date.now();

  for (const node of nodes) {
    if (cancelRequested) {
      figma.ui.postMessage({ type: "scan-cancelled" });
      return;
    }

    const component = owningComponent(node);
    const inButton = !!(component && /button/i.test(component.name));
    const excluded = await excludedByName(node, exclusions, instanceNameCache);
    const included = await includedByName(node, inclusions, instanceNameCache);

    for (const field of CORNER_FIELDS) {
      const value = node[field];
      const mapped = mappedRadius(value, mappings);
      if (!mapped) continue;
      if (excluded) {
        excludedCorners++;
        continue;
      }
      if (!included) {
        outsideIncludeCorners++;
        continue;
      }
      const bound = isCornerBound(node, field);

      const key = radiusGroupKey(mapped, bound);
      let group = groups.get(key);
      if (!group) {
        group = {
          field: "radius",
          from: mapped.from,
          to: mapped.to,
          bound,
          nodes: [],
          fieldsByNode: new Map(),
        };
        groups.set(key, group);
      }
      let fields = group.fieldsByNode.get(node);
      if (!fields) {
        fields = [];
        group.fieldsByNode.set(node, fields);
        group.nodes.push(node);
      }
      fields.push(field);
      if (bound) boundCorners++;
      else rawCorners++;
      if (inButton) buttonCorners++;
    }

    if (Date.now() - sliceStart > 16) {
      await yieldToUI();
      sliceStart = Date.now();
    }
  }

  lastScanGroups = groups;

  const summary = [];
  for (const [key, group] of groups) {
    const matches = tokensAtValue(tokens, group.to);
    summary.push({
      key,
      kind: "radius",
      source: group.bound ? "bound" : "raw",
      from: group.from,
      to: group.to,
      count: group.nodes.length,
      cornerCount: cornerCountFor(group),
      matches,
    });
  }
  summary.sort((a, b) => a.from - b.from || (a.source === b.source ? 0 : a.source === "raw" ? -1 : 1));

  figma.ui.postMessage({
    type: "radius-scan-result",
    groups: summary,
    scannedNodeCount: nodes.length,
    cornerCount: rawCorners + boundCorners,
    rawCorners,
    boundCorners,
    buttonCorners,
    excludedCorners,
    outsideIncludeCorners,
    inclusionActive: inclusions.length > 0,
    tokenCount: tokens.length,
    skippedInstances: collected.skippedInstances,
    selectionScope,
  });
}

async function applyRadius(selections) {
  cancelRequested = false;
  const selected = selections || [];
  let updatedCorners = 0;
  let reboundCorners = 0;
  let failedCorners = 0;
  let skippedBound = 0;
  let missingGroups = 0;
  let cancelled = false;
  const variableCache = new Map();

  async function getVariableCached(variableId) {
    if (!variableId) return null;
    if (variableCache.has(variableId)) return variableCache.get(variableId);
    const variable = await figma.variables.getVariableByIdAsync(variableId);
    variableCache.set(variableId, variable);
    return variable;
  }

  let processed = 0;
  let total = 0;
  for (const sel of selected) {
    const group = lastScanGroups.get(sel.key);
    if (group && group.fieldsByNode) total += cornerCountFor(group);
  }

  let sliceStart = Date.now();

  outer: for (const sel of selected) {
    const group = lastScanGroups.get(sel.key);
    if (!group || !group.fieldsByNode) {
      missingGroups++;
      continue;
    }

    const variable = sel.variableId ? await getVariableCached(sel.variableId) : null;
    if (sel.variableId && !variable) {
      failedCorners += cornerCountFor(group);
      processed += cornerCountFor(group);
      continue;
    }

    for (const node of group.nodes) {
      if (cancelRequested) {
        cancelled = true;
        break outer;
      }
      if (!node || node.removed) {
        failedCorners += (group.fieldsByNode.get(node) || []).length;
        processed += (group.fieldsByNode.get(node) || []).length;
        continue;
      }
      const fields = group.fieldsByNode.get(node) || [];
      for (const field of fields) {
        if (cancelRequested) {
          cancelled = true;
          break outer;
        }
        try {
          const stillBound = isCornerBound(node, field);
          const stillMatches = valueMatches(node[field], group.from);
          if (!stillMatches) {
            // Value changed since the scan. Leave it alone.
          } else if (variable) {
            if (group.bound !== stillBound) {
              skippedBound++;
            } else {
              node.setBoundVariable(field, variable);
              reboundCorners++;
            }
          } else if (stillBound) {
            if (sel.writeRaw) {
              node.setBoundVariable(field, null);
              node[field] = group.to;
              updatedCorners++;
            } else {
              skippedBound++;
            }
          } else {
            node[field] = group.to;
            updatedCorners++;
          }
        } catch (e) {
          failedCorners++;
        }
        processed++;
        if (Date.now() - sliceStart > 16) {
          figma.ui.postMessage({
            type: "apply-progress",
            done: processed,
            total,
            unit: "corners",
          });
          await yieldToUI();
          sliceStart = Date.now();
        }
      }
    }
  }

  figma.ui.postMessage({
    type: "apply-result",
    kind: "radius",
    successNodes: updatedCorners + reboundCorners,
    updatedCorners,
    reboundCorners,
    failedNodes: failedCorners,
    skippedBound,
    missingGroups,
    cancelled,
  });
}

// ---- Applying ---------------------------------------------------------

let lastScanGroups = new Map(); // key ("field|value") -> { field, value, nodes: Node[] }
let lastLocated = null; // { key, index, node } — last node shown via the crosshair
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

const UI_EXPANDED = { width: 640, height: 520 };
const UI_COMPACT = { width: 440, height: 520 };

figma.showUI(__html__, { width: UI_EXPANDED.width, height: UI_EXPANDED.height, themeColors: true });

function clampWindowSize(width, height) {
  const w = Math.max(280, Math.min(1600, Math.round(width) || UI_EXPANDED.width));
  const h = Math.max(200, Math.min(1400, Math.round(height) || UI_EXPANDED.height));
  return { width: w, height: h };
}

Promise.all([
  figma.clientStorage.getAsync("ui-compact").catch(() => false),
  figma.clientStorage.getAsync("ui-size").catch(() => null),
]).then(([compact, size]) => {
  if (compact) figma.ui.postMessage({ type: "compact", compact: true });
  const saved = size && size.width && size.height ? clampWindowSize(size.width, size.height) : null;
  const next = saved || (compact ? UI_COMPACT : null);
  if (next) figma.ui.resize(next.width, next.height);
}).catch(() => {});

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
  } else if (msg.type === "scan-radius") {
    try {
      await scanRadius(msg);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "apply-radius") {
    await applyRadius(msg.selections);
  } else if (msg.type === "clear-scan") {
    lastScanGroups = new Map();
    lastLocated = null;
  } else if (msg.type === "apply") {
    await apply(msg.selections);
  } else if (msg.type === "cancel" || msg.type === "cancel-apply") {
    cancelRequested = true;
  } else if (msg.type === "refresh-libraries") {
    await sendLibraries();
  } else if (msg.type === "locate") {
    try {
      await locate(msg);
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "skip-located") {
    try {
      await skipLocated();
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "inspect-selection") {
    try {
      await inspectSelection();
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "resize") {
    const size = msg.compact ? UI_COMPACT : UI_EXPANDED;
    figma.ui.resize(size.width, size.height);
    figma.clientStorage.setAsync("ui-compact", !!msg.compact).catch(() => {});
    figma.clientStorage.setAsync("ui-size", size).catch(() => {});
  } else if (msg.type === "resize-window") {
    const size = clampWindowSize(msg.width, msg.height);
    figma.ui.resize(size.width, size.height);
    if (msg.persist) figma.clientStorage.setAsync("ui-size", size).catch(() => {});
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};
