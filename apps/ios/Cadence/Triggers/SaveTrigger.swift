/// Fires when the user asks to save the recent conversation as a memory.
protocol SaveTrigger {
    var fires: AsyncStream<Void> { get }
}
