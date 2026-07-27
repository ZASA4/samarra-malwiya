# CLAUDE.md — Project AL-MALWIYYA

## What this project is

An interactive 3D web scene of the Malwiya minaret in Samarra, capital of
the Abbasid Caliphate, set at sunset in 861 CE. The minaret is generated
procedurally in code, not modelled by hand.

This is a portfolio project. Its purpose is to demonstrate real engineering
skill to hiring managers.

**Stack:** Three.js + Vite (vanilla JavaScript, no framework)
**Target:** Web browser, deployed on Vercel
**Team size:** 1 junior developer
**Hardware:** MacBook Pro M3 Pro, 18 GB unified memory

---

## HARD RULES

### 1. Original IP only
This is NOT Assassin's Creed. Never reference that brand, its Brotherhood,
Animus, Eagle Vision, or any Ubisoft asset. We build in the genre; we do
not borrow the brand.

### 2. Scope is locked
Deliverable: ONE interactive scene. One building. No characters, no combat,
no gameplay, no open world. If a request expands beyond that, push back
before writing code.

### 3. Performance budget
18 GB unified memory, integrated GPU. Target 60fps at 1440p.
Keep draw calls under 50. Cap device pixel ratio at 2.

### 4. Historical accuracy is the pitch
Samarra was real. If unsure about a historical detail, flag it as needing
verification rather than inventing plausible filler.

---

## How I want you to work with me

I am a junior developer and I am still learning. Therefore:

- **Explain before you code.** 3-5 lines on what you are about to do and why.
- **Small steps.** One system at a time. Never rewrite files I did not mention.
- **Comment generously.** I need to understand every line, because I will be
  asked about this code in job interviews.
- **After each task, quiz me.** Ask me 2 short questions about what you just
  wrote, to check I actually understand it. Do not skip this.
- **Tell me when I am wrong.** Directly. I would rather hear it now.
- Keep your replies to me tight. I am on a limited plan.

---

## Conventions

- camelCase for functions and variables, PascalCase for classes
- One module per file, small and focused
- All tuning values exposed via lil-gui, never hardcoded
- Conventional commit messages: feat:, fix:, chore:, docs:

## Definition of done

- [ ] Runs with no console errors
- [ ] Holds 60fps
- [ ] No magic numbers
- [ ] I can explain what it does
- [ ] Committed with a clear message
