import path from "path";
import dotenv from "dotenv";
dotenv.config();
import { resolveDefaultLlm, providerSupportsWebTools } from "../llm/resolveLlm";
import { generateOntology } from "../core/pipeline";
import { emitPackage } from "../core/emit";

const main = async () => {
  const userPrompt = process.argv.slice(2).join(" ");
  if (!userPrompt) {
    console.error('Usage: yarn generate-agents "<goal or problem statement>"');
    process.exit(1);
  }

  const llm = resolveDefaultLlm();
  const provider = process.env.PRINCIPLES_PROVIDER ?? "xai";
  console.log(`Provider: ${provider} (model: ${process.env.PRINCIPLES_MODEL ?? "default"})`);
  console.log("Deriving and vetting truths, decomposing, generating agent specs...");
  const report = await generateOntology(llm, userPrompt, {
    webSurvey: providerSupportsWebTools(),
  });

  // Surface what the mechanisms found — this is the point of building them.
  if (report.vet.assumptions.length > 0) {
    console.log("\nProceeding on these ASSUMPTIONS (correct me if wrong):");
    for (const a of report.vet.assumptions) console.log(`  - ${a.statement}`);
  }
  if (report.vet.rejected.length > 0) {
    console.log("\nRejected candidate truths:");
    for (const r of report.vet.rejected) console.log(`  - "${r.truth.statement}" — ${r.attack}`);
  }
  console.log(`\nDecomposition: ${report.decomposition.status} after ${report.decomposition.iterations} iteration(s).`);
  if (report.decomposition.status === "escalated") {
    console.log(`  Stuck on criteria: ${report.decomposition.stuckOn.join(", ")} — review the ontology before trusting it.`);
  }

  const baseDir = path.join(__dirname, "..", "..");
  const packageName = `agent-package-${Date.now()}`;
  const pkgDir = emitPackage(baseDir, report, path.join(baseDir, "packages"), packageName);
  console.log(`\nPackage created: ${pkgDir}`);
  console.log(`Run it with:\n  cd packages/${packageName} && npm install && npm run run-agents "<prompt>"`);
};

main().catch((err) => {
  console.error("Generation failed:", err.message);
  process.exit(1);
});
