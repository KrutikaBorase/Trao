#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildKitFromCase } from '../backend/pipeline.js';

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let outputPath = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--input') inputPath = args[i + 1];
    if (arg === '--output') outputPath = args[i + 1];
  }

  if (!inputPath || !outputPath) {
    console.error('Usage: npm run evaluate -- --input <cases.json> --output <kits.json>');
    process.exit(1);
  }

  const inputFile = path.resolve(process.cwd(), inputPath);
  const outputFile = path.resolve(process.cwd(), outputPath);

  let cases;
  try {
    cases = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (error) {
    console.error(`Could not read input file: ${error.message}`);
    process.exit(1);
  }

  if (!Array.isArray(cases)) {
    console.error('Input file must contain an array of cases.');
    process.exit(1);
  }

  const results = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    kits: [],
  };

  for (const item of cases) {
    try {
      const result = await buildKitFromCase({
        id: item.id,
        jd: item.jd,
        company_url: item.company_url,
        days: item.days,
      });
      results.kits.push({
        id: item.id,
        status: result.status,
        kit: result.kit,
        error: result.error,
      });
    } catch (error) {
      results.kits.push({
        id: item.id,
        status: 'failed',
        kit: null,
        error: {
          code: 'PIPELINE_ERROR',
          message: error.message,
        },
      });
    }
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`Wrote ${results.kits.length} kit results to ${outputFile}`);
}

main();
