#!/usr/bin/env node
// Extracts May 31 flight entries from data/prices.json and prints them.

const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "prices.json");

const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));

const may31Flights = Object.fromEntries(
  Object.entries(data).filter(([id]) => id.includes("may31"))
);

if (Object.keys(may31Flights).length === 0) {
  console.log("No May 31 flights found in prices.json");
  process.exit(0);
}

console.log(JSON.stringify(may31Flights, null, 2));
