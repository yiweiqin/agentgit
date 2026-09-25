/*
 * AgenticGit panel runtime.
 *
 * Runs inside the host's sandboxed iframe for an MCP App, and inside the standalone board
 * page. It is plain ES5-flavoured JavaScript with no imports and no build step: the
 * resource has to be one self-contained document, because a sandbox that blocks
 * `<script src>` fails silently and shows an empty panel rather than an error.
 *
 * Three things about the environment shape all of it.
 *
 * 1. **The host is reached over `postMessage`, not `fetch`.** The bridge is the only
 *    channel guaranteed to exist, so polling goes through `tools/call` rather than an HTTP
 *    call to the daemon — a request to `localhost` would be refused by the sandbox CSP on
 *    any host that does not allow-list it, and it would fail as an empty table.
 * 2. **A tool result is not a promise that anything was called.** The panel can be opened
 *    in a side-panel tab with no tool call behind it, so it fetches its own data on load
 *    and never relies on being handed a result.
 * 3. **Every bridge call may fail.** A host may not implement `ui/message`, or may refuse
 *    `ui/request-display-mode`. Each one is optional and each failure degrades to a visible
 *    state rather than a broken panel.
 *
 * Query parameters, all optional, all used by the standalone board:
 *   ?workspace=<id>   which workspace to ask for, when the host serves several
 *   ?interval=<ms>    poll interval, defaults to 4000
 *   ?transport=http   skip the bridge and read `../api/graph` instead
 */

(function () {
  'use strict'

  var PROTOCOL_VERSION = '2026-01-26'
  var GRAPH_TOOL = 'agentgit_graph'
  var EXPLAIN_TOOL = 'agentgit_explain'
  var APP_VERSION = '0.1.0'

  var LANE_COLORS = [
    'var(--ag-primary)',
    'var(--ag-blue)',
    'var(--ag-orange)',
    'var(--ag-green)',
    'var(--ag-red)',
  ]

var params = new URLSearchParams(window.location.search)
// The host renders this document without query parameters, so anything the server wants the
// panel to know arrives as a data attribute on the root element. Query parameters win,
// because they are what a human adds when they are debugging a saved panel by hand.
var root = document.getElementById('ag-app')
function attr(name) {
  return root ? root.getAttribute(name) : null
}

var workspaceId = params.get('workspace') || attr('data-workspace-id')
// A panel that is not inside a frame has no host to talk to. That is the case when the
// saved panel file is opened straight from disk, or when the board embeds it as a page, and
// in both the daemon on localhost is the only source of data.
var standalone = window.parent === window
var useHttp = params.get('transport') === 'http' || attr('data-transport') === 'http' || standalone
// Nullish rather than falsy: a daemon rendering this panel into its own origin passes an
// empty base on purpose, and `'' + '/api/graph'` is the same-origin path that is wanted.
var httpBase = params.get('base') ?? attr('data-base') ?? (standalone ? 'http://localhost:7777' : '.')
var intervalMs = Number(params.get('interval')) || Number(attr('data-interval')) || 4000

  var state = {
    view: null,
    selected: null,
    filter: null,
    bridgeReady: false,
    bridgeError: null,
    lastUpdated: null,
    answer: null,
    answerFor: null,
    busy: false,
    // Signatures of what is currently on screen. The panel re-renders on a timer, and
    // rebuilding a subtree that has not changed destroys focus, in-progress typing and text
    // selection — so every render is compared against these first.
    graphSignature: null,
    detailOid: null,
  }

  /* ------------------------------------------------------------------ dom -- */

  function byId(id) {
    return document.getElementById(id)
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /* --------------------------------------------------------------- bridge -- */

  var bridge = (function () {
    var nextId = 1
    var pending = {}
    var listeners = []

    function post(message) {
      // The host is the parent frame. `'*'` is required: a sandboxed iframe has an opaque
      // origin, so there is no origin string to match against.
      window.parent.postMessage(message, '*')
    }

    window.addEventListener(
      'message',
      function (event) {
        if (event.source !== window.parent) return
        var message = event.data
        if (!message || message.jsonrpc !== '2.0') return

        if (message.id !== undefined && Object.prototype.hasOwnProperty.call(pending, message.id)) {
          var entry = pending[message.id]
          delete pending[message.id]
          if (message.error) entry.reject(new Error(message.error.message || 'bridge error'))
          else entry.resolve(message.result)
          return
        }

        if (typeof message.method === 'string') {
          for (var i = 0; i < listeners.length; i += 1) listeners[i](message.method, message.params)
        }
      },
      { passive: true },
    )

    function request(method, payload, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var id = nextId
        nextId += 1
        var timer = setTimeout(function () {
          if (Object.prototype.hasOwnProperty.call(pending, id)) {
            delete pending[id]
            reject(new Error(method + ' timed out'))
          }
        }, timeoutMs || 15000)
        pending[id] = {
          resolve: function (value) {
            clearTimeout(timer)
            resolve(value)
          },
          reject: function (error) {
            clearTimeout(timer)
            reject(error)
          },
        }
        post({ jsonrpc: '2.0', id: id, method: method, params: payload || {} })
      })
    }

    return {
      request: request,
      on: function (handler) {
        listeners.push(handler)
      },
      notify: function (method, payload) {
        post({ jsonrpc: '2.0', method: method, params: payload || {} })
      },
    }
  })()

  /** Hand the host the tool result shape MCP defines, whatever wrapper it arrived in. */
  function unwrapToolResult(result) {
    if (!result || typeof result !== 'object') return null
    if (result.structuredContent) return result.structuredContent
    if (result.result && result.result.structuredContent) return result.result.structuredContent
    return null
  }

  function callTool(name, args) {
    var payload = { name: name, arguments: args || {} }
    if (workspaceId) payload.arguments.workspace = workspaceId
    return bridge.request('tools/call', payload).then(function (result) {
      if (result && result.isError) {
        var text = textOfToolResult(result)
        throw new Error(text || 'the tool reported an error')
      }
      return result
    })
  }

  function textOfToolResult(result) {
    var blocks = (result && result.content) || []
    var parts = []
    for (var i = 0; i < blocks.length; i += 1) {
      if (blocks[i] && blocks[i].type === 'text') parts.push(blocks[i].text)
    }
    return parts.join('\n')
  }

  /* ----------------------------------------------------------------- data -- */

  function loadGraph() {
    if (useHttp) return loadGraphOverHttp()
    return callTool(GRAPH_TOOL, {}).then(function (result) {
      var structured = unwrapToolResult(result)
      if (!structured) throw new Error('the graph tool returned no structured content')
      return structured
    })
  }

  function loadGraphOverHttp() {
    var url = httpBase + '/api/graph'
    if (workspaceId) url += '?w=' + encodeURIComponent(workspaceId)
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return response.json()
    })
  }

  function refresh() {
    if (state.busy) return Promise.resolve()
    state.busy = true
    return loadGraph()
      .then(function (view) {
        state.view = view
        state.lastUpdated = new Date()
        state.bridgeError = null
        state.bridgeReady = true
        render()
        setLive(true)
      })
      .catch(function (error) {
        state.bridgeError = error.message || String(error)
        setLive(false)
        render()
      })
      .then(function () {
        state.busy = false
      })
  }

  function setLive(live) {
    var dot = byId('ag-live')
    if (!dot) return
    dot.setAttribute('data-live', live === true ? '1' : '0')
  }

  /* ---------------------------------------------------------------- render -- */

  function lanesInUse(view) {
    var max = 0
    for (var i = 0; i < view.nodes.length; i += 1) {
      if (view.nodes[i].lane > max) max = view.nodes[i].lane
    }
    // Lanes beyond a handful are unreadable at this width; the cap keeps the gutter from
    // eating the row. A node in a higher lane is clamped into the last drawn column, which
    // is a rendering compromise the lane number still reports truthfully in the detail pane.
    return Math.min(max + 1, 6)
  }

  function visibleNodes() {
    var view = state.view
    if (!view) return []
    if (!state.filter) return view.nodes
    var out = []
    for (var i = 0; i < view.nodes.length; i += 1) {
      if (view.nodes[i].label === state.filter) out.push(view.nodes[i])
    }
    return out
  }

  function render() {
    var view = state.view
    if (!view) {
      byId('ag-legend').innerHTML = ''
      byId('ag-graph').innerHTML = '<p class="ag-empty">Loading the commit graph…</p>'
      byId('ag-detail-body').innerHTML = '<p class="ag-empty">Waiting for the first refresh.</p>'
      byId('ag-overlay').innerHTML = ''
      byId('ag-ask').hidden = true
      renderFooter()
      return
    }

    var nodes = visibleNodes()
    var laneCount = lanesInUse(view)

    // The graph, the legend and the title are rebuilt only when their content changed. On a
    // four-second timer that is most ticks, and a rebuild is what makes a live panel flicker
    // and drop a row's hover state.
    var signature = graphSignature(view, nodes, laneCount)
    if (signature !== state.graphSignature) {
      state.graphSignature = signature
      byId('ag-title').innerHTML = 'AgenticGit for <span class="ag-ws">' + esc(view.workspaceName) + '</span>' + (state.filter ? ' <span class="ag-tag" data-kind="task">' + esc(state.filter) + '</span>' : '')
      renderLegend(view)
      renderGraph(nodes, laneCount)
    }

    renderDetail()
    renderOverlay(view)
    renderFooter()
  }

  /**
   * A cheap signature of everything the graph subtree draws from.
   *
   * Built from the ids, lanes and file counts rather than from the rendered HTML: comparing
   * markup would cost as much as rendering it, and all this needs to answer is "would this
   * look the same".
   */
  function graphSignature(view, nodes, laneCount) {
    var parts = [view.workspaceName, laneCount, state.filter || '', state.selected || '', nodes.length]
    for (var i = 0; i < nodes.length; i += 1) {
      parts.push(nodes[i].oid, nodes[i].lane, nodes[i].label, nodes[i].filesChanged, nodes[i].head ? 1 : 0)
    }
    return parts.join('|')
  }

  function renderLegend(view) {
    var host = byId('ag-legend')
    if (!view.labels.length) {
      host.innerHTML = '<p class="ag-empty">No commits attributed yet.</p>'
      return
    }
    var html = ''
    for (var i = 0; i < view.labels.length; i += 1) {
      var item = view.labels[i]
      var active = state.filter === item.label
      html +=
        '<button class="ag-chip" type="button" data-label="' +
        esc(item.label) +
        '" data-source="' +
        esc(item.source) +
        '" aria-pressed="' +
        (active ? 'true' : 'false') +
        '" title="' +
        esc(item.label + ' — ' + item.source) +
        '">' +
        '<span class="ag-name">' +
        esc(item.label) +
        '</span>' +
        '<span class="ag-count">' +
        esc(item.commits) +
        '</span>' +
        '</button>'
    }
    if (state.filter) html += '<button class="ag-btn" type="button" id="ag-clear-filter">Clear</button>'
    host.innerHTML = html
  }

  function renderGraph(nodes, laneCount) {
    var host = byId('ag-graph')
    if (!nodes.length) {
      host.innerHTML = '<p class="ag-empty">' + (state.filter ? 'Nothing from this window.' : 'No commits in this repository yet.') + '</p>'
      return
    }

    var rowH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ag-row-h')) || 30
    var laneW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ag-lane-w')) || 14
    var gutter = laneCount * laneW + 10
    var height = nodes.length * rowH

    var index = {}
    for (var i = 0; i < nodes.length; i += 1) index[nodes[i].oid] = i

    var paths = ''
    for (var n = 0; n < nodes.length; n += 1) {
      var node = nodes[n]
      for (var p = 0; p < node.parents.length; p += 1) {
        var to = index[node.parents[p]]
        if (to === undefined) continue
        var color = LANE_COLORS[(node.lane < 0 ? 0 : node.lane) % LANE_COLORS.length]
        paths += edgePath(
          laneX(node.lane, laneW, gutter),
          n * rowH + rowH / 2,
          laneX(nodes[to].lane, laneW, gutter),
          to * rowH + rowH / 2,
          color,
          rowH,
        )
      }
    }

    var svg = '<svg class="ag-lanes" width="100%" height="' + height + '" aria-hidden="true">' + paths + '</svg>'

    var rows = ''
    for (var r = 0; r < nodes.length; r += 1) {
      rows += renderRow(nodes[r], r * rowH + rowH / 2 - 4.5, laneW, gutter)
    }

    host.innerHTML = '<div class="ag-graph-inner" style="height:' + height + 'px">' + svg + rows + '</div>'
  }

  function laneX(lane, laneW, gutter) {
    return 6 + Math.min(lane, 5) * laneW + laneW / 2
  }

  function edgePath(x1, y1, x2, y2, color, rowH) {
    if (x1 === x2) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + color + '" stroke-width="1.6" />'
    }
    var mid = Math.min(rowH, Math.abs(y2 - y1) / 2)
    return (
      '<path d="M ' +
      x1 +
      ' ' +
      y1 +
      ' C ' +
      x1 +
      ' ' +
      (y1 + mid) +
      ', ' +
      x2 +
      ' ' +
      (y2 - mid) +
      ', ' +
      x2 +
      ' ' +
      y2 +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="1.6" />'
    )
  }

  function renderRow(node, nodeTop, laneW, gutter) {
    var tags = ''
    if (node.head) tags += '<span class="ag-tag" data-kind="head">HEAD</span>'
    for (var i = 0; i < node.refs.length; i += 1) {
      var ref = node.refs[i]
      if (ref === 'HEAD') continue
      var kind = /^agentgit\//.test(ref) ? 'task' : ref.indexOf('tag:') === 0 ? 'task' : 'branch'
      tags += '<span class="ag-tag" data-kind="' + kind + '">' + esc(ref.replace(/^tag:\s*/, '')) + '</span>'
    }

    return (
      '<div class="ag-row" role="button" tabindex="0" data-oid="' +
      esc(node.oid) +
      '" aria-selected="' +
      (state.selected === node.oid ? 'true' : 'false') +
      '" style="padding-left:' +
      gutter +
      'px">' +
      '<span class="ag-node" data-head="' +
      (node.head ? '1' : '0') +
      '" style="left:' +
      (laneX(node.lane, laneW, gutter) - 4.5) +
      'px; top:' +
      nodeTop +
      'px"></span>' +
      '<span class="ag-name" data-source="' +
      esc(node.labelSource) +
      '" title="' +
      esc(node.label + ' (' + node.labelSource + ')') +
      '">' +
      esc(node.label) +
      '</span>' +
      '<span class="ag-oid">' +
      esc(node.short) +
      '</span>' +
      '<span class="ag-subject" title="' +
      esc(node.subject) +
      '">' +
      esc(node.subject || '(no message)') +
      '</span>' +
      '<span class="ag-refs">' +
      tags +
      '</span>' +
      '<span class="ag-files">' +
      (node.filesChanged ? esc(node.filesChanged) + 'f' : '') +
      '</span>' +
      '</div>'
    )
  }

  function findNode(oid) {
    var nodes = (state.view && state.view.nodes) || []
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].oid === oid) return nodes[i]
    }
    return null
  }

  function renderDetail() {
    var host = byId('ag-detail-body')
    var node = state.selected ? findNode(state.selected) : null
    if (!node) {
      state.detailOid = null
      host.innerHTML = '<p class="ag-empty">Select a commit to see who made it, what it changed, and to ask about it.</p>'
      byId('ag-ask').hidden = true
      return
    }
    byId('ag-ask').hidden = false

    // Rebuilt only when the selection actually changed. Doing it on every refresh would
    // overwrite whatever the developer had typed into the question box every few seconds,
    // which makes the box impossible to use.
    if (state.detailOid !== node.oid) {
      state.detailOid = node.oid
      var files = ''
      for (var i = 0; i < node.files.length; i += 1) files += '<li>' + esc(node.files[i]) + '</li>'

      host.innerHTML =
        '<dl class="ag-kv">' +
        kv('window', esc(node.label) + ' <span class="ag-tag" data-kind="task">' + esc(node.labelSource) + '</span>') +
        kv('commit', '<code>' + esc(node.oid.slice(0, 12)) + '</code>') +
        kv('when', esc(new Date(node.committedAt).toLocaleString())) +
        kv('author', esc(node.authorName)) +
        (node.taskId ? kv('task', '<code>' + esc(node.taskId) + '</code>') : '') +
        (node.sessionIds.length ? kv('session', '<code>' + esc(node.sessionIds.join(', ').slice(0, 60)) + '</code>') : '') +
        (node.refs.length ? kv('refs', esc(node.refs.join(', '))) : '') +
        kv('files', esc(node.filesChanged)) +
        '</dl>' +
        (node.files.length ? '<h2>Changed</h2><ul class="ag-files-list">' + files + '</ul>' : '')

      byId('ag-question').value = defaultQuestion(node)
    }

    // Always, so an answer that arrives after the box was drawn still appears.
    renderAnswer(node)
  }

  function kv(key, value) {
    return '<dt>' + esc(key) + '</dt><dd>' + value + '</dd>'
  }

  function defaultQuestion(node) {
    return 'Explain commit ' + node.short + ' in this workspace: which conversation produced it, what was it trying to do, and what did it change?'
  }

  function renderAnswer(node) {
    var host = byId('ag-answer')
    if (state.answer && state.answerFor === node.oid) {
      host.hidden = false
      host.textContent = state.answer
      return
    }
    host.hidden = true
    host.textContent = ''
  }

  function renderOverlay(view) {
    var host = byId('ag-overlay')
    var list = view.overlay || []
    if (!list.length) {
      host.innerHTML = '<p class="ag-empty">Every worktree is clean. Nothing is in flight.</p>'
      return
    }
    var html = '<ul class="ag-overlay-list">'
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i]
      // Three states, and they are different answers: a window was identified, the worktree is
      // on a task branch with no session recorded, or the ledger never saw a write here.
      var who
      if (entry.label) {
        who =
          '<strong class="ag-name" data-source="' +
          esc(entry.labelSource || 'task') +
          '">' +
          esc(entry.label) +
          '</strong>'
      } else if (entry.taskId) {
        who = '<strong class="ag-name" data-source="task">' + esc(entry.taskId) + '</strong>'
      } else {
        who = '<em class="ag-name">no window recorded</em>'
      }
      html +=
        '<li>' +
        who +
        '<span class="ag-where">' +
        esc(entry.main ? 'main checkout' : entry.branch || 'worktree') +
        ' · ' +
        esc(entry.worktree) +
        '</span>' +
        '<span class="ag-count">' +
        esc(entry.paths.length) +
        ' uncommitted</span>' +
        '</li>'
    }
    html += '</ul>'
    host.innerHTML = html
  }

  function renderFooter() {
    var view = state.view
    var parts = []
    if (view) {
      parts.push(esc(view.nodes.length) + ' commits · ' + esc(view.lanes) + ' lane(s) · ' + esc(view.branch || 'detached'))
      parts.push(esc(view.repo))
    }
    if (state.lastUpdated) parts.push('updated ' + state.lastUpdated.toLocaleTimeString())
    byId('ag-foot-left').innerHTML = parts.join(' · ')

    var right = byId('ag-foot-right')
    if (state.bridgeError) {
      right.innerHTML =
        '<span class="ag-warn">' +
        esc(useHttp ? 'board HTTP failed: ' : 'host bridge failed: ') +
        esc(state.bridgeError) +
        '</span>'
      return
    }
    right.textContent = useHttp ? 'live board' : 'host bridge connected'
  }

  /* -------------------------------------------------------------- actions -- */

  function select(oid) {
    state.selected = state.selected === oid ? null : oid
    // Through `render`, not by redrawing the graph directly, so the signature comparison stays
    // the single place that decides what needs rebuilding.
    render()
    pushContext()
  }

  function pushContext() {
    var node = state.selected ? findNode(state.selected) : null
    var text = node
      ? 'AgenticGit panel: the developer is looking at commit ' + node.short + ' (' + node.subject + ') attributed to "' + node.label + '".'
      : 'AgenticGit panel: the developer is looking at the commit graph for ' + ((state.view && state.view.workspaceName) || 'this workspace') + '.'
    // Silent, and best-effort: a host without this method should not show an error for a
    // convenience the developer never asked for.
    bridge.request('ui/update-model-context', { content: [{ type: 'text', text: text }] }, 4000).catch(function () {})
  }

  function ask(prompt) {
    if (!prompt) return
    if (useHttp) {
      // With no host there is nothing to converse with, so the offline explanation is the
      // only honest answer rather than a message that goes nowhere.
      explain()
      return
    }
    bridge
      .request('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] })
      .catch(function () {
        // ChatGPT-specific fallback, feature-detected rather than assumed.
        if (window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
          return window.openai.sendFollowUpMessage({ prompt: prompt, scrollToBottom: true })
        }
        throw new Error('this host does not accept messages from a panel')
      })
      .catch(function (error) {
        state.answer = 'Could not send to the conversation: ' + (error.message || error) + '\n\nUse "Quick answer" for an offline explanation.'
        state.answerFor = state.selected
        renderDetail()
      })
  }

  /** Resolve an explanation as plain text, over the bridge or over the board's HTTP API. */
  function explainText(oid) {
    if (useHttp) {
      var url = httpBase + '/api/explain?oid=' + encodeURIComponent(oid)
      if (workspaceId) url += '&w=' + encodeURIComponent(workspaceId)
      return fetch(url, { headers: { accept: 'application/json' } }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      }).then(function (payload) {
        return payload.text || ''
      })
    }
    return callTool(EXPLAIN_TOOL, { oid: oid }).then(function (result) {
      return textOfToolResult(result)
    })
  }

  function explain() {
    var node = state.selected ? findNode(state.selected) : null
    if (!node) return
    var host = byId('ag-answer')
    host.hidden = false
    host.textContent = 'Reading the ledger…'
    explainText(node.oid)
      .then(function (text) {
        state.answer = text || 'No explanation is recorded for this commit yet.'
        state.answerFor = node.oid
        renderDetail()
      })
      .catch(function (error) {
        host.textContent = 'Could not read the ledger: ' + (error.message || error)
      })
  }

  function requestFullscreen() {
    bridge
      .request('ui/request-display-mode', { mode: 'fullscreen' })
      .catch(function () {
        if (window.openai && typeof window.openai.requestDisplayMode === 'function') {
          return window.openai.requestDisplayMode({ mode: 'fullscreen' })
        }
        throw new Error('this host cannot change the display mode')
      })
      .catch(function () {})
  }

  function openBoard() {
    if (useHttp) {
      // Already on the board, or opened with no host: there is nothing to ask.
      return
    }
    bridge
      .request('ui/open-link', { url: 'http://localhost:7777' })
      .catch(function () {
        if (window.openai && typeof window.openai.openExternal === 'function') {
          return window.openai.openExternal({ href: 'http://localhost:7777' })
        }
        throw new Error('this host cannot open links')
      })
      .catch(function (error) {
        state.answer = 'Open http://localhost:7777 in a browser (run `agentgit up` first). ' + (error.message || '')
        state.answerFor = state.selected
        renderDetail()
      })
  }

  /* --------------------------------------------------------------- events -- */

  function wire() {
    document.addEventListener('click', function (event) {
      var chip = event.target.closest ? event.target.closest('.ag-chip') : null
      if (chip) {
        var label = chip.getAttribute('data-label')
        state.filter = state.filter === label ? null : label
        render()
        return
      }
      if (event.target.closest && event.target.closest('#ag-clear-filter')) {
        state.filter = null
        render()
        return
      }
      var row = event.target.closest ? event.target.closest('.ag-row') : null
      if (row) {
        select(row.getAttribute('data-oid'))
        return
      }
      if (event.target.closest && event.target.closest('#ag-refresh')) {
        refresh()
        return
      }
      if (event.target.closest && event.target.closest('#ag-fullscreen')) {
        requestFullscreen()
        return
      }
      if (event.target.closest && event.target.closest('#ag-board')) {
        openBoard()
        return
      }
      if (event.target.closest && event.target.closest('#ag-quick')) {
        explain()
        return
      }
      if (event.target.closest && event.target.closest('#ag-send')) {
        ask(byId('ag-question').value.trim())
        return
      }
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && event.target && event.target.id === 'ag-question') {
        event.preventDefault()
        ask(byId('ag-question').value.trim())
      }
    })

    bridge.on(function (method, payload) {
      if (method === 'ui/notifications/tool-result') {
        var structured = payload && payload.structuredContent
        if (structured && structured.nodes) {
          state.view = structured
          state.lastUpdated = new Date()
          state.bridgeError = null
          state.bridgeReady = true
          render()
          setLive(true)
        }
      }
      if (method === 'ui/notifications/host-context-changed' && payload && payload.theme) {
        document.documentElement.setAttribute('data-theme', payload.theme)
      }
    })
  }

  /* ----------------------------------------------------------------- boot -- */

  function boot() {
    wire()
    render()
    if (useHttp) {
      refresh()
      setInterval(refresh, intervalMs)
      return
    }
    bridge
      .request('ui/initialize', {
        appInfo: { name: 'agentgit-panel', version: APP_VERSION, title: 'AgenticGit' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen', 'pip'] },
        protocolVersion: PROTOCOL_VERSION,
      })
      .then(function (result) {
        bridge.notify('ui/notifications/initialized', {})
        state.bridgeReady = true
        if (result && result.hostContext) {
          document.documentElement.setAttribute('data-host', String(result.hostContext.displayMode || 'inline'))
        }
      })
      .catch(function (error) {
        // Not fatal, and deliberately not shown as an error on its own: a host that does
        // not implement the handshake may still serve `tools/call`, and the first refresh
        // is what decides whether the panel actually has a channel.
        state.bridgeError = null
        state.handshakeError = error.message || String(error)
      })
      .then(function () {
        refresh()
        setInterval(refresh, intervalMs)
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
