// ladder/dashboard/lane.mjs — which of your four lanes a lead belongs to, if any.
//
// Since 2026-11-02 the hunt loads wide and cleans after: the scrapers keep everything that is not
// certainly junk, and this decides what the board shows. Your lanes, in your words: FDE, AI
// workflows, AI generalist, ML. Everything else is `off`, and an off-lane lead is dropped with
// the reason written on the row, never silently binned.
//
// It replaces the scrape-time LANE regex in portals.mjs, which had two blind spots measured the
// night this was written: "Forward Deployment Engineer" (the regex wanted "deployed") and every
// backend / full-stack role at an AI-native startup, which is your generalist lane.
//
// Pure functions. No database, no network; `clean.mjs` does the writing.

// Certainly not you, whatever else the title says. Kept in step with ANTI in sweep/portals.mjs.
const JUNK = /\b(intern(ship)?|fresher|trainee|apprentice|trainer|teacher|tutor|faculty|sales|bpo|telecall|recruiter|data entry|annotat[a-z]*|labell?[a-z]*|content writer|seo|freelanc[a-z]*|electrical|mechanical|firmware|embedded|iot|hardware|civil|qa engineer|tester)\b/i;
// A title with none of these is not an engineering seat: "AI Strategy Consultant", "Product
// Manager - GenAI", "Data Analyst". You want to stay hands-on, so these are off however AI they are.
const ENGINEERING = /engineer|developer|architect|scientist|\bsde\b|programmer|\bmle\b|\bfde\b|builder|hacker|technologist|coder/i;
const NONTECH = /\b(manager|consultant|analyst|strategist|marketing|product owner|program|project|business|operations|specialist|executive|associate|officer|advisor|evangelist|writer|support)\b/i;
// Off even with AI in the title: these seats own a roadmap, a pipeline or a P&L, not code.
// Presales too: a demo / technical-sales seat is not a hands-on one, whatever the title says.
const NOT_HANDS_ON = /pre-?sales|product manager|project manager|program manager|marketing|account (manager|executive)|business (analyst|development)|human resources|\bhr (manager|executive|generalist|business partner)|operations (manager|executive)|instructor/i;

const FDE = /forward[\s-]?deploy(?:ed|ment)?|partner[\s-]deployed|\bfde\b|\bfdse\b/i;
// Customer-facing engineering seats count whatever the company name says, so they are FDE on
// the title alone, as the old scrape regex had it.
const FDE_TITLE = /solutions? (engineer|architect)|deployment engineer|customer engineer|implementation engineer|ai outcome/i;
// These need an AI signal: a "Field Engineer" at a telecom is a technician. Cursor's passes on
// its JD. (Solutions Architect moved up 2026-11-02: Databricks and Shakudo were being dropped.)
const FDE_ADJ = /field (ai )?engineer|integration engineer|partner engineer|applied ai architect/i;
const WORKFLOW = /automation|workflow|agentic|\bagents?\b|agentcore|\bn8n\b|zapier|langgraph|langchain|orchestrat|copilot|chat ?bot|conversational|voice ai|\brag\b/i;
const ML = /machine lea?rn?i?ng|\bml\b|ml ?ops|deep learning|\bnlp\b|computer vision|data scien(tist|ce)|applied scientist|research (scientist|engineer)|\bmle\b|model (training|serving|evaluation)|inference|world models?/i;
// "AIML" as one word (GlobalLogic, BMW TechWorks, ServiceNow): \bai\b misses it. Found 2026-11-13.
const GENAI = /\bai\b|\bai[\/-]|\baiml\b|artificial intelligence|gen ?ai|generative|\bllms?\b|prompt|\bgpt\b|bedrock|vertex ai|openai|vector (db|database|search)|embedding/i;
const BUILDER = /software|backend|back[\s-]end|full[\s-]?stack|platform|product engineer|python|\bsde\b|developer|engineer|technical staff|\bmts\b/i;
// A founding seat at a 2026 startup is an AI-builder seat often enough that you apply to them
// on the title (GetCrux, Vela); the JD gate check reads the rest.
// The employer's own name says AI: "Lyzr AI", "Orvera AI", "Optifye.ai", "Kalpa Labs (YC F25)"
// does not, which is why the card text is a second witness.
const AI_COMPANY = /(\bai\b|\.ai\b|\bai$|^ai\b|\bagents?\b|\bllm|\bgpt|neural|intelligence\b)/i;
const AI_TEXT = /\b(llms?|agentic|ai agents?|gen ?ai|generative ai|langchain|langgraph|\brag\b|vector database|openai|anthropic|claude|gpt-?4|fine-?tun)/i;

export const LANES = ['fde', 'workflows', 'generalist', 'ml'];
export const LANE_LABEL = { fde: 'FDE', workflows: 'AI workflows', generalist: 'AI generalist', ml: 'ML', off: 'off-lane' };

/**
 * { lane: 'fde' | 'workflows' | 'generalist' | 'ml' | 'off', why }
 * `lead` needs role and company; fit_note / jd_text help when the title alone is generic.
 */
export function laneOf(lead, co = null) {
  const role = String(lead.role || '').replace(/\s*\(Verified job\)\s*/i, ' ').trim();
  const company = String(lead.company || '');
  // The companies table's `lane` column holds a one-line description for the researched ones
  // ("Voice AI orchestration"), which is the best evidence there is for a generic title.
  const text = `${lead.fit_note || ''} ${(lead.jd_text || '').slice(0, 4000)} ${co?.lane || ''} ${co?.why || ''}`;
  // "AISquared", "AIonOS": no word boundary after the AI, so test the capitalised prefix too.
  const aiCo = AI_COMPANY.test(company) || /^AI[A-Z]/.test(company);
  const aiText = AI_TEXT.test(text);

  if (!role) return { lane: 'off', why: 'no title' };
  if (JUNK.test(role)) return { lane: 'off', why: `"${role.match(JUNK)[0]}" title` };
  if (NOT_HIM.test(role)) return { lane: 'off', why: `${role.match(NOT_HIM)[0]} is not a hands-on seat` };
  // "Consultant, AI Evaluations" stays; "Research Analyst" does not.
  if (!ENGINEERING.test(role) && NONTECH.test(role) && !FDE.test(role) && !GENAI.test(role) && !ML.test(role))
    return { lane: 'off', why: 'not an engineering title' };

  if (FDE.test(role)) return { lane: 'fde', why: 'forward deployed title' };
  if (FDE_TITLE.test(role)) return { lane: 'fde', why: `${role.match(FDE_TITLE)[0]} title` };
  if (FDE_ADJ.test(role) && (GENAI.test(role) || ML.test(role) || WORKFLOW.test(role) || aiCo || aiText))
    return { lane: 'fde', why: `${role.match(FDE_ADJ)[0]} with an AI signal` };
  // "Automation" alone is test automation or RPA as often as it is AI; it needs a second witness.
  if (WORKFLOW.test(role) && (GENAI.test(role) || aiCo || aiText || /agentic|agents?|agentcore|langgraph|langchain|n8n|\brag\b|chat ?bot|conversational|copilot/i.test(role)))
    return { lane: 'workflows', why: `${role.match(WORKFLOW)[0]} title` };
  if (ML.test(role)) return { lane: 'ml', why: `${role.match(ML)[0]} title` };
  if (GENAI.test(role)) return { lane: 'generalist', why: 'AI title' };
  if (/founding/i.test(role)) return { lane: 'generalist', why: 'founding engineer' };
  if (BUILDER.test(role) && (aiCo || aiText))
    return { lane: 'generalist', why: aiCo ? 'engineer at an AI-native company' : 'engineer, card or JD is about LLMs / agents' };
  return { lane: 'off', why: 'no AI signal in the title, the company or the posting' };
}
