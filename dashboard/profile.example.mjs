// ladder/dashboard/profile.example.mjs — a made-up persona, and the template for your own.
//
// Copy this file to `profile.local.mjs` (gitignored) and fill it in. Until you do, the tool runs
// on this example so a fresh clone boots. Every field is optional; a missing one turns the
// feature that needs it off rather than crashing.
export default {
  owner: 'Alex Example',
  currentCtcLpa: 12,                 // current fixed pay in lakh/yr; drives the "+N% on your ₹XL" hint
  yearsExperience: 3,                // used to pick AmbitionBox's experience band
  homeCity: 'Bengaluru',             // answered truthfully on "where are you" location gates
  homeRegion: 'blr',                 // a locBucket region (ncr | blr | ...) that gets a small home bonus

  // Filled into contact fields on application forms (LinkedIn / phone / GitHub questions).
  identity: {
    title: 'Senior Software Engineer',
    employer: 'Example Corp',
    location: 'Bengaluru',
    notice: '1 month',
    phone: '+91-0000000000',
    linkedin: 'https://linkedin.com/in/alex-example',
    github: 'github.com/alex-example',
  },

  // What your resume says, as terms a JD can be matched against. Weight 3 = the lane you want,
  // 2 = a core tool you have shipped with, 1 = a generic "software job" term. `resumeTex` is
  // optional: `node profile.mjs --check` greps its \skillrow{}{} macros for uncovered tokens.
  resumeTex: null,
  skills: [
    { k: 'agents',     w: 3, re: /\bagent(s|ic)?\b|multi[- ]agent/i },
    { k: 'llm',        w: 3, re: /\bllms?\b|large language|gen(erative)?[- ]?ai/i },
    { k: 'rag',        w: 2, re: /\brag\b|retrieval[- ]augmented|vector (db|database|store)|embeddings?/i },
    { k: 'python',     w: 2, re: /\bpython\b/i },
    { k: 'postgres',   w: 2, re: /postgres(ql)?|\bsql\b/i },
    { k: 'aws',        w: 2, re: /\baws\b|\bgcp\b|\bazure\b/i },
    { k: 'docker',     w: 1, re: /\bdocker\b|containers?/i },
    { k: 'api-design', w: 1, re: /\brest(ful)?\b|\bapis?\b/i },
  ],
  // Named gaps: a JD requiring one costs `pen` points, capped at gapCap in total.
  gaps: [
    { k: 'kubernetes', pen: 10, re: /\bkubernetes\b|\bk8s\b/i },
    { k: 'java',       pen: 8,  re: /\bjava\b(?!script)|\bspring boot\b/i },
  ],
  gapCap: 25,

  // Claims you must never make in writing (they failed your own fact-check). A draft that
  // matches one is blocked before it can be queued.
  forbiddenClaims: [
    { re: /10x (faster|improvement)/i, why: 'no benchmark backs this' },
  ],

  // The intro note. The block whose `tags` the role matches most carries the note; a second
  // matching block contributes its body. Order breaks ties.
  letter: {
    blocks: {
      platform: {
        tags: /agent|platform|backend|python|distributed|reliab/i,
        hook: () => `Getting an agent to work once is easy. Getting it to fail safely is the job.`,
        body: `At Example Corp I built the service that runs our agents in production: retries are classified before they happen, and every side effect is idempotent.`,
        push: `Most agent systems retry everything and then can't explain their own error rates.`,
      },
      data: {
        tags: /rag|retriev|search|embedding|vector|data/i,
        hook: () => `Retrieval quality is a data problem before it is a model problem.`,
        body: `I rebuilt our document pipeline so that every chunk carries its source and freshness, which cut wrong answers more than any prompt change did.`,
        push: `An eval set you trust is worth more than a bigger model.`,
      },
    },
    // Optional: one line about current work, added unless that block already leads the note.
    current: { block: 'data', line: `Right now I'm building an eval harness for retrieval over changing documents.` },
    disposition: `I'd rather rebuild something than defend it.`,
    closing: id => `${id.location}, ${id.notice} notice. Currently ${id.title} at ${id.employer}.`,
  },

  // Your own answers to custom application questions. Salary, visa and "why us" are always
  // refused generically by sweep/apply.mjs; write those per application instead.
  answers: [
    { re: /most impressive thing .*(built|achieved|done)|proudest|impressive project/i,
      a: `The production agent runner at Example Corp: idempotent side effects and classified retries.` },
    { re: /notice period|when can you (start|join)|availability/i,
      a: `One month from acceptance. Open to remote or relocation.` },
  ],

  // The dashboard's file panel, relative to the folder above dashboard/. Missing files are hidden.
  kit: [
    { group: 'Resume', glob: ['resume/resume.pdf'] },
    { group: 'Notes',  dir: 'notes', ext: '.md' },
  ],
};
