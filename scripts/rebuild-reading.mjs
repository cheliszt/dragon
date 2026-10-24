import path from "node:path";
import { rebuildReadingOutputs } from "../src/reading-outputs.mjs";

if (!process.argv[2]) throw new Error("请提供已翻译项目的目录。");
const model = await rebuildReadingOutputs(path.resolve(process.argv[2]));
console.log(JSON.stringify({ paragraphs: model.units.filter((u) => !u.artifact).length,
  issues: model.issues.length, bodyIssues: model.issues.filter((q) => q.scope === "body").length,
  auxiliaryIssues: model.issues.filter((q) => q.scope === "auxiliary").length, version: model.version }, null, 2));
