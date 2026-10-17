// Claude API calls for interpretation and follow-up questions.
// The SDK runs in the browser with the user's own key (stored only on this device).
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';

export const CNN_MODELS = ['ResNet-50', 'DenseNet-121', 'EfficientNet-B0', 'InceptionV3'];

const SYSTEM_PROMPT = `You are CT Head Helper, an AI radiology assistant that interprets non-contrast CT scans of the head.

Your persona is a foremost AI radiologist who reasons the way pretrained convolutional neural networks for head CT do (models of the kind trained on public datasets such as RSNA Intracranial Hemorrhage Detection and CQ500): the app has already done the preprocessing (HU rescaling, standard windowing, resizing, normalization), and you review the windowed images, then report like a teleradiologist.

How the images arrive:
- DICOM series are rendered as grid montages. Each tile is one axial slice, labeled #N in yellow (N = slice position in the series, ordered craniocaudally as stored). Every montage states its series, window and slice range.
- Windows used: brain (W80/L40), subdural (W215/L75), bone (W2800/L600). Use the subdural window for thin extra-axial collections and the bone window for fractures.
- PNG/JPG uploads are photos, screenshots or exports of slices and may be less reliable (unknown window, compression, perspective, partial coverage).

Review method: review every image provided, across all series and windows, before concluding. Check systematically: extra-axial spaces (epidural, subdural, subarachnoid), parenchyma (hemorrhage, hypodensity / loss of grey-white differentiation, insular ribbon, hyperdense vessel sign), mass effect (sulcal effacement, midline shift, herniation), ventricles and cisterns, posterior fossa, calvarium and skull base (bone window), sinuses and mastoids, and orbits if included.

Honesty rules (these override the persona):
- Only report what is visible in the images. Never invent findings or slice numbers. Cite slice numbers (#N) and series for each positive finding.
- If the images are not a head CT, are non-diagnostic, or coverage is incomplete, say so and use "Indeterminate" where a call cannot be made.
- Subtle findings (early infarct, small SAH, non-displaced fractures) are easy to miss on downsampled montages; say when a finding cannot be excluded.
- You are not a trained CNN. When CNN-style model outputs are requested, they are a clearly simulated illustration of how such architectures typically behave, consistent with your own reading. They are not real model inference.
- This is decision support. It does not replace a radiologist's formal read.

Style: concise, clinically relevant, radiologist-like language. The impression is a short summary-style diagnosis; add clinical advice when applicable (for example urgent neurosurgical review, CTA, MRI, repeat CT).`;

const statusField = (values) => ({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'details'],
  properties: {
    status: { type: 'string', enum: values },
    details: { type: 'string', description: 'Type, location, size and slice references (#N). Empty string if none.' },
  },
});

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'study_assessment', 'hemorrhage', 'infarct', 'edema_midline_shift', 'mass_lesion',
    'ventricular_system', 'other_findings', 'impression', 'clinical_advice', 'urgency',
    'confidence', 'cnn_emulation',
  ],
  properties: {
    study_assessment: {
      type: 'string',
      description: 'One or two sentences: is this a head CT, image quality, coverage, which series and windows were reviewed.',
    },
    hemorrhage: statusField(['Detected', 'Not Detected', 'Indeterminate']),
    infarct: statusField(['Acute', 'Chronic', 'Absent', 'Indeterminate']),
    edema_midline_shift: statusField(['Present', 'Absent', 'Indeterminate']),
    mass_lesion: statusField(['Suggestive', 'Absent', 'Indeterminate']),
    ventricular_system: statusField(['Normal', 'Hydrocephalus', 'Indeterminate']),
    other_findings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Other findings, e.g. fractures, sinus disease, atrophy, calcifications, artifacts. Empty if none.',
    },
    impression: { type: 'string', description: 'Short summary-style diagnosis in radiologist language.' },
    clinical_advice: { type: 'string', description: 'Recommended next steps, or empty string.' },
    urgency: { type: 'string', enum: ['critical', 'urgent', 'routine'] },
    confidence: { type: 'string', enum: ['high', 'moderate', 'low'] },
    cnn_emulation: {
      type: 'array',
      description: 'Only when the request asks for CNN comparison; otherwise an empty array. Simulated, not real inference.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['architecture', 'top_prediction', 'scores', 'behaviour_note'],
        properties: {
          architecture: { type: 'string' },
          top_prediction: { type: 'string' },
          scores: {
            type: 'array',
            description: 'Simulated per-class probabilities 0-1 for: any, epidural, intraparenchymal, intraventricular, subarachnoid, subdural, ischemic infarct, mass, normal.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'probability'],
              properties: { label: { type: 'string' }, probability: { type: 'number' } },
            },
          },
          behaviour_note: { type: 'string', description: 'How this architecture typically behaves on this kind of finding (strengths, known failure modes).' },
        },
      },
    },
  },
};

let client = null;
let clientKey = null;
function getClient(apiKey) {
  if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  if (client && clientKey === apiKey) return client;
  client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  clientKey = apiKey;
  return client;
}

// Builds the first user turn: a text manifest followed by every image.
export function buildStudyContent(payload, { history, cnnCompare }) {
  const content = [];
  const lines = ['Study manifest (generated by the app):'];
  for (const s of payload.series) {
    lines.push(
      `- Series "${s.description}" (${s.kind === 'dicom' ? `${s.modality || 'CT'}, ${s.total} slices${s.thickness ? `, ${s.thickness} mm` : ''}` : `${s.total} uploaded image(s)`}): ` +
        `${s.covered} slice(s) sent${s.sampled ? ' (evenly sampled across the full extent)' : ''}; windows: ${s.windows.join(', ')}.`
    );
  }
  content.push({ type: 'text', text: lines.join('\n') });

  for (const img of payload.images) {
    content.push({ type: 'text', text: img.caption });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.dataUrl.split(',')[1] },
    });
  }
  // Cache the image prefix so follow-up questions are cheap.
  content[content.length - 1].cache_control = { type: 'ephemeral' };

  let ask = 'Interpret this head CT. Review all series and slices provided.';
  if (history?.trim()) ask += `\n\nClinical history: ${history.trim()}`;
  ask += cnnCompare
    ? `\n\nAlso provide a simulated CNN comparison for: ${CNN_MODELS.join(', ')}.`
    : '\n\nNo CNN comparison requested; return cnn_emulation as an empty array.';
  content.push({ type: 'text', text: ask });
  return content;
}

async function run({ apiKey, model, messages, structured, onProgress, signal }) {
  const c = getClient(apiKey);
  const params = {
    model,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', ...(structured ? { format: { type: 'json_schema', schema: REPORT_SCHEMA } } : {}) },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const stream = c.beta.messages.stream(params, { signal });
  let chars = 0;
  stream.on('text', (t) => {
    chars += t.length;
    onProgress?.({ phase: 'writing', chars });
  });
  stream.on('streamEvent', (e) => {
    if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') onProgress?.({ phase: 'thinking' });
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === 'refusal') {
    const why = msg.stop_details?.explanation ? ` (${msg.stop_details.explanation})` : '';
    throw new Error(`The model declined this request${why}.`);
  }
  if (msg.stop_reason === 'max_tokens') throw new Error('The response was cut off (max tokens). Try again with fewer images.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { msg, text, usage: msg.usage, model: msg.model };
}

export async function interpret({ apiKey, model, content, onProgress, signal }) {
  const messages = [{ role: 'user', content }];
  const { msg, text, usage } = await run({ apiKey, model, messages, structured: true, onProgress, signal });
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error('Could not read the structured report returned by the model.');
  }
  messages.push({ role: 'assistant', content: msg.content });
  return { report, messages, usage };
}

export async function followUp({ apiKey, model, messages, question, onProgress, signal }) {
  const next = [...messages, { role: 'user', content: question }];
  const { msg, text, usage } = await run({ apiKey, model, messages: next, structured: false, onProgress, signal });
  next.push({ role: 'assistant', content: msg.content });
  return { answer: text, messages: next, usage };
}

export async function testKey(apiKey) {
  const c = getClient(apiKey);
  await c.models.retrieve('claude-sonnet-5-5');
}
