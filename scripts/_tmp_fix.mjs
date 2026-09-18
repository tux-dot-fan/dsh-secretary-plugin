import { readFileSync, writeFileSync } from 'node:fs'
const files = [
  "/home/dean/Code/dsh-secretary-plugin/package.json",
  "/home/dean/.dsh/profiles/web/node_modules/dsh-secretary/package.json",
]
for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"))
  const before = JSON.stringify(pkg.dsh)
  if (pkg.dsh && pkg.dsh.client) delete pkg.dsh.client
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.client) delete pkg.dsh.bundle.client
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8")
  console.log(file, "=>", before, "=>", JSON.stringify(pkg.dsh))
}
