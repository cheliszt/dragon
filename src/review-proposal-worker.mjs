import { runProposal } from "./review-proposals.mjs";
const [root, dir, id] = process.argv.slice(2);
await runProposal(root, dir, id);
