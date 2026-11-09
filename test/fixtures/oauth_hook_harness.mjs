// Drives assets/tango_oauth_hook.js against a minimal fake browser and prints
// the events the hook forwards to the LiveComponent as JSON.
import TangoOAuth from "../../assets/tango_oauth_hook.js"

const callbackOrigin = "https://api.example.test"
const listeners = {}
const popup = { closed: false, focus() {}, close() { this.closed = true } }
const otherWindow = { closed: false, focus() {}, close() {} }

globalThis.window = {
  addEventListener: (type, fn) => { listeners[type] = fn },
  removeEventListener: () => {},
  open: () => popup,
  screenX: 0,
  screenY: 0,
  outerWidth: 1200,
  outerHeight: 800,
}

// A fake BroadcastChannel: one per name, delivering only while open
const channels = {}
class FakeBroadcastChannel {
  constructor(name) {
    this.name = name
    this.closed = false
    channels[name] = this
  }
  postMessage() {}
  close() { this.closed = true }
}
globalThis.BroadcastChannel = FakeBroadcastChannel
window.BroadcastChannel = FakeBroadcastChannel
const deliver = (name, event) => {
  const channel = channels[name]
  if (channel && !channel.closed && channel.onmessage) channel.onmessage(event)
}

// Timers run by hand, so a popup that reads as closed is noticed at once
const timers = new Map()
let nextTimer = 1
globalThis.setInterval = (fn) => {
  const id = nextTimer++
  timers.set(id, fn)
  return id
}
globalThis.clearInterval = (id) => { timers.delete(id) }
const tick = () => { for (const fn of [...timers.values()]) fn() }

const pushed = []
const handlers = {}
const hook = Object.create(TangoOAuth)
hook.el = { dataset: { componentId: "oauth" } }
hook.pushEventTo = (selector, event, payload) => pushed.push({ selector, event, payload })
hook.handleEvent = (name, fn) => { handlers[name] = fn }
hook.mounted()

const open = () => {
  popup.closed = false
  handlers.open_popup({
    url: "https://provider.example.test/authorize",
    intent_reference: "intent-1",
    callback_origin: callbackOrigin,
  })
}

const scenarios = {}
const run = (name, event) => {
  open()
  pushed.length = 0
  listeners.message(event)
  scenarios[name] = pushed.map((entry) => ({ event: entry.event, payload: entry.payload }))
  hook.cleanup()
}

const good = {
  type: "oauth_complete",
  completion_handle: "opaque-handle",
  intent_reference: "intent-1",
}

run("complete", { source: popup, origin: callbackOrigin, data: good })
run("complete_with_extra_fields", {
  source: popup,
  origin: callbackOrigin,
  data: { ...good, token: "leaked-token", connection: { token: "leaked-token" } },
})
run("wrong_origin", { source: popup, origin: "https://evil.example.test", data: good })
run("wrong_source", { source: otherWindow, origin: callbackOrigin, data: good })
run("wrong_intent", {
  source: popup,
  origin: callbackOrigin,
  data: { ...good, intent_reference: "intent-2" },
})
run("legacy_connection_payload", {
  source: popup,
  origin: callbackOrigin,
  data: { type: "oauth_complete", connection: { token: "legacy-token" } },
})
run("missing_handle", {
  source: popup,
  origin: callbackOrigin,
  data: { type: "oauth_complete", intent_reference: "intent-1" },
})
run("error", {
  source: popup,
  origin: callbackOrigin,
  data: { type: "oauth_error", error: "invalid_grant", intent_reference: "intent-1" },
})
run("error_wrong_origin", {
  source: popup,
  origin: "https://evil.example.test",
  data: { type: "oauth_error", error: "invalid_grant", intent_reference: "intent-1" },
})

// A provider's Cross-Origin-Opener-Policy cuts the popup off: it reads as closed while still
// in use, and the callback page sends the result on the sign-in's channel instead.
const runCutOff = (name, event, channelName = "tango_oauth:intent-1") => {
  open()
  pushed.length = 0
  popup.closed = true
  tick()
  deliver(channelName, event)
  scenarios[name] = pushed.map((entry) => ({ event: entry.event, payload: entry.payload }))
  hook.cleanup()
}

runCutOff("channel_complete", { origin: callbackOrigin, data: good })
runCutOff("channel_wrong_origin", { origin: "https://evil.example.test", data: good })
runCutOff("channel_wrong_intent", {
  origin: callbackOrigin,
  data: { ...good, intent_reference: "intent-2" },
})
runCutOff("channel_other_name", { origin: callbackOrigin, data: good }, "tango_oauth:intent-2")
scenarios.channel_names = Object.keys(channels)

// The channel closes once the sign-in completes, so a second message is ignored.
open()
pushed.length = 0
deliver("tango_oauth:intent-1", { origin: callbackOrigin, data: good })
deliver("tango_oauth:intent-1", { origin: callbackOrigin, data: good })
scenarios.channel_once = pushed.map((entry) => ({ event: entry.event, payload: entry.payload }))
hook.cleanup()

// Messages that arrive with no popup open are ignored.
pushed.length = 0
listeners.message({ source: popup, origin: callbackOrigin, data: good })
scenarios.no_popup = pushed.map((entry) => ({ event: entry.event, payload: entry.payload }))

hook.destroyed()
console.log(JSON.stringify(scenarios))
