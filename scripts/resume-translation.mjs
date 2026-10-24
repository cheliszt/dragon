import path from "node:path";
import { translateProject } from "../src/pipeline.mjs";

const directory = path.resolve(process.argv[2]);
try {
  const result = await translateProject(directory);
  console.log(JSON.stringify({ status: result.manifest.status, outputs: result.manifest.outputs, qa: result.report.summary }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
