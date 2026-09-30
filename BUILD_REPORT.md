# Wildwood Project Build Report

## Summary
✅ **Installation**: Successfully completed
⚠️ **Build**: Partially successful (7 of 8 packages built)

---

## Installation Details
- **Command**: `pnpm install`
- **Duration**: 24.8 seconds
- **Status**: ✅ SUCCESS
- **Package Manager**: pnpm v10.33.0
- **Packages Resolved**: 819 packages
- **Packages Downloaded**: 810 packages
- **Dependencies Installed**: 
  - oxfmt 0.18.0
  - oxlint 1.73.0
  - syncpack 13.0.2
  - turbo 2.9.4
  - typescript 7.0.2

### Installation Warnings
- Ignored build scripts for `msw@2.12.14` (security measure)
- Deprecated pnpm field in package.json (`pnpm.onlyBuiltDependencies`)

---

## Build Details
- **Command**: `pnpm build`
- **Build Tool**: Turbo 2.9.4
- **Total Duration**: 1m 17s
- **Packages in Scope**: 8 packages
- **Successfully Built**: 7 packages
- **Failed**: 1 package (play)

### ✅ Successfully Built Packages

1. **wildwood-store** (837ms)
   - Output: `packages/store/dist/`
   - Size: 127.72 kB (4 files)
   - Format: ESM (.mjs) with TypeScript definitions

2. **wildwood-shared** (678ms)
   - Output: `packages/shared/dist/`
   - Size: 18.60 kB (4 files)
   - Format: ESM (.mjs) with TypeScript definitions

3. **wildwood-ui** (477ms)
   - Output: `packages/ui/dist/`
   - Size: 0.75 kB (4 files)
   - Format: CommonJS (.js) with TypeScript definitions

4. **wildwood-kit** (1054ms)
   - Output: `packages/kit/dist/`
   - Size: 338.60 kB (4 files)
   - Format: CommonJS (.js) with TypeScript definitions
   - Includes Tailwind CSS compilation

5. **wildwood-vscode** (91ms)
   - Output: `packages/extension/dist/`
   - Size: 109.75 kB (1 file)
   - Format: CommonJS (.js)

6. **wildwood** (9959ms - main package)
   - Output: `packages/wildwood/dist/`
   - Size: 9.49 MB (106 files)
   - Includes multiple entry points for Next.js and React
   - Successfully copied wildwood-vscode into bundled-extension/

7. **docs** (Next.js app - ~40s)
   - Output: `apps/docs/.next/`
   - Status: ✅ Built successfully
   - Type checking: Completed in 9.7s
   - Static pages: 16 pages generated

### ❌ Failed Package

**play** (Next.js app)
- Error: "The 'id' argument must be of type string. Received undefined"
- Exit code: 1
- The build worker exited unexpectedly during the build process
- TypeScript dependencies were auto-installed during build

---

## Available Scripts

### Core Scripts
- `pnpm build` - Build all packages using Turbo
- `pnpm start` - Start all applications
- `pnpm dev` - Run development mode for all packages

### Development Scripts
- `pnpm dev:web` - Run web playground with dependencies
- `pnpm dev:web-play` - Alias for dev:web
- `pnpm dev:docs` - Run documentation site with dependencies
- `pnpm playground` - Alias for dev:web
- `pnpm dev:vscode-playground` - Run VSCode playground

### Code Quality
- `pnpm lint` - Run oxlint on all files
- `pnpm lint:fix` - Run oxlint with auto-fix
- `pnpm format` - Format code with oxfmt
- `pnpm format:check` - Check code formatting
- `pnpm typecheck` - Run TypeScript type checking

### Database/Studio
- `pnpm studio:wildwood` - Run studio for wildwood package
- `pnpm studio:web-db` - Run studio for web database

### Testing
- `pnpm test:wildwood` - Run tests for wildwood package
- `pnpm test:wildwood:watch` - Run tests in watch mode

---

## Build Output Locations

```
/project/wildwood/
├── packages/
│   ├── extension/dist/          ✅ (108 KB)
│   ├── kit/dist/                ✅ (344 KB)
│   ├── shared/dist/             ✅ (28 KB)
│   ├── store/dist/              ✅ (136 KB)
│   ├── ui/dist/                 ✅ (16 KB)
│   └── wildwood/
│       ├── dist/                ✅ (8.9 MB)
│       └── bundled-extension/   ✅
└── apps/
    ├── docs/.next/              ✅ (built successfully)
    └── play/.next/              ❌ (build failed)
```

---

## Notable Build Warnings

1. **TypeScript 7.0 Experimental**
   - TypeScript 7.0 does not yet have a stable API
   - Some options may be unavailable

2. **Sourcemap Warning (wildwood-kit)**
   - tailwind-inline plugin didn't generate sourcemap
   - Sourcemap may be incorrect

3. **Plugin Timings Warning (wildwood)**
   - Build spent significant time in:
     - rolldown-plugin-dts:resolver (51%)
     - rolldown-plugin-dts:generate (26%)
     - tsdown:deps (13%)

4. **Peer Dependencies (play)**
   - better-auth 1.7.0-rc.1 expects drizzle-orm@^0.45.2
   - Found drizzle-orm@1.0.0-beta.20

---

## Recommendations

1. **Fix play app build failure**
   - Investigate the "id argument must be of type string" error
   - Check for configuration issues in apps/play
   - Review Next.js configuration

2. **Update TypeScript**
   - Consider waiting for TypeScript 7.0 stable release
   - Or downgrade to TypeScript 6.x for stability

3. **Resolve peer dependency warnings**
   - Update drizzle-orm to match better-auth requirements
   - Or update better-auth version

4. **Enable build scripts for msw**
   - Run `pnpm approve-builds` if msw scripts are needed

---

## Log Files
- Installation log: `/project/wildwood/install.log`
- Build log: `/project/wildwood/build.log`

## Build Date
Generated: $(date)
