# Lead Finder

A tool I built for my web design side business. It scans Google Maps across 937 US cities for local businesses with great reviews but **no website** (the best people to pitch a website to) and tracks each one through my sales pipeline.

## How it works

- **One control: "Find N new businesses."** The scanner drives a real Chrome window with Playwright, sweeping 937 US cities (population 25k–300k) across 20 trades like handyman, locksmith, plumber and landscaping. It stops the moment it has found exactly N qualifying leads, remembers where it stopped, and picks up from the same city and trade next time.
- **Strict filters.** Only independent businesses with no website, a 3.5★+ rating and 50+ reviews. Franchises and chains (3+ locations) are filtered out, and no business is ever listed twice.
- **Pipeline board.** Leads are sorted by stage (sold → replied → texted → new → dead) and ranked by rating × review count, so the best pitch in each stage sits on top.
- **Build and pitch.** Each lead gets a workspace folder for a custom demo site, a preview link, and a one-click email draft.

## Built with

Node.js with only the built-in `http` server (no framework) · Playwright for the scanner · a single-page vanilla JavaScript board.

## Run it

```bash
npm install
node server.js   # http://localhost:3777
```

Scanning opens a visible Chrome window, so Google Chrome needs to be installed.

## Not in this repo

The real lead list (business names and phone numbers) and the demo sites I built for real businesses stay private.

## What I learned

My first pitch got a reply, and the owner looked at the demo site while we were texting, but I never got a price into the conversation and the deal went cold. Lesson: put the price in the second text.

## How I built it

I built this with [Claude Code](https://claude.com/claude-code) as my coding partner. The business idea, the filters and the pipeline were mine, and I ran the scans and pitched the leads myself. Claude wrote most of the code.
