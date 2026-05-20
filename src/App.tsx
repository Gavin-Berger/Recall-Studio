import "./App.css";

function App() {
  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Recall Studio</p>
        <h1>Creative session memory for Ableton producers.</h1>
        <p className="subtitle">
          Track Ableton activity, review session history, and turn production
          work into clean session logs.
        </p>
      </section>

      <section className="status-grid">
        <div className="card">
          <span className="label">Max for Live</span>
          <strong className="offline">Disconnected</strong>
          <p>Waiting for heartbeat from the Ableton device.</p>
        </div>

        <div className="card">
          <span className="label">Active Session</span>
          <strong>Not Started</strong>
          <p>No session is currently being tracked.</p>
        </div>

        <div className="card">
          <span className="label">Storage</span>
          <strong>Local First</strong>
          <p>All session data will be stored on this machine.</p>
        </div>
      </section>

      <section className="actions">
        <button>Start Session</button>
        <button className="secondary">Import Recording</button>
        <button className="secondary">Settings</button>
      </section>
    </main>
  );
}

export default App;
