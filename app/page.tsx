import Link from "next/link";

export default function Home() {
  return (
    <main className="shell">
      <header className="masthead">
        <div className="candle">
          <div className="flame" />
          <div className="wax" />
        </div>
        <h1>VIGIL</h1>
        <p className="tagline">
          A zero-knowledge dead man&apos;s switch on Midnight.
          <br />
          While the owner keeps their vigil, the vault is sealed.
        </p>
      </header>

      <section className="setup">
        <h2>Step 1 &middot; Run the proof server the Midnight way</h2>
        <p className="lead">
          Generating a zero-knowledge proof requires your private inputs: your
          secret key, your heir&apos;s commitment secret, your real balance.
          The component that sees them is the proof server. That is why
          Midnight designed it to run on <em>your</em> machine: your secrets
          never leave it, and only the finished proof touches the chain.
        </p>

        <div className="codeblock">
          <span className="codelabel">Pull the proof server</span>
          <code>docker pull midnightntwrk/proof-server:latest</code>
        </div>
        <div className="codeblock">
          <span className="codelabel">Run it on port 6300</span>
          <code>
            docker run -p 6300:6300 midnightntwrk/proof-server:latest
            midnight-proof-server -v
          </code>
        </div>

        <p className="lead">
          With the proof server running locally, clone the repo and follow the
          README to point your DApp at <code className="inline">localhost:6300</code>.
          This is the production topology: trustless end to end.
        </p>
      </section>

      <section className="skip">
        <h2>Step 2 &middot; Or try it right now</h2>
        <p className="lead">
          No Docker handy? A hosted demo runs the same compiled circuits
          server-side, clearly labeled with what that trade-off means.
        </p>
        <div className="cta-row">
          <Link href="/vault" className="cta primary">
            Skip to vault now
          </Link>
          <a
            href="https://github.com/cnpierrepapi/vigil-midnight#readme"
            className="cta ghost"
            target="_blank"
            rel="noopener noreferrer"
          >
            README
          </a>
        </div>
      </section>

      <footer className="footer">
        Built during the Midnight Hackathon, July 17-19, 2026. Five Compact
        circuits, compiled and tested: arm, keepVigil, deposit, proveFunded,
        claim. The deadline is protocol-enforced by kernel block time, not an
        off-chain witness.
      </footer>
    </main>
  );
}
