// Raw probe of the indexer unshieldedTransactions subscription.
// Dumps the first few payloads so we can compare against the SDK's
// expected schema (SyncSchema.js) and find the decode mismatch.
import WebSocket from "ws";

const WS_URL = "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";
const ADDRESS =
  "mn_addr_preprod1rskenxg9smg5z3995a3kexmynwzq3a3kkwn5dpgzxvpur7elwtdqwgsp4f";

const QUERY = `subscription UnshieldedTransactions($address: UnshieldedAddress!, $transactionId: Int) {
  unshieldedTransactions(address: $address, transactionId: $transactionId) {
    ... on UnshieldedTransaction {
      type: __typename
      transaction {
        type: __typename
        id
        hash
        protocolVersion
        block { timestamp }
        ... on RegularTransaction {
          identifiers
          fees { paidFees estimatedFees }
          transactionResult { status segments { id success } }
        }
      }
      createdUtxos { owner tokenType value outputIndex intentHash ctime registeredForDustGeneration }
      spentUtxos { owner tokenType value outputIndex intentHash ctime registeredForDustGeneration }
    }
    ... on UnshieldedTransactionsProgress {
      type: __typename
      highestTransactionId
    }
  }
}`;

const ws = new WebSocket(WS_URL, "graphql-transport-ws");
let count = 0;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "connection_init" }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "connection_ack") {
    ws.send(
      JSON.stringify({
        id: "1",
        type: "subscribe",
        payload: {
          query: QUERY,
          variables: { address: ADDRESS, transactionId: 0 },
        },
      }),
    );
    return;
  }
  console.log(JSON.stringify(msg, null, 2));
  count += 1;
  if (count >= 5 || msg.type === "error" || msg.type === "complete") {
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("WS ERROR:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("TIMEOUT after 30s with", count, "messages");
  process.exit(0);
}, 30_000);
