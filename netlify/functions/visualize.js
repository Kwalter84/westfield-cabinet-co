// netlify/functions/visualize.js
//
// Handles the "Visualize Your Kitchen" feature:
//   1. Takes a customer's kitchen photo + chosen finish
//   2. Asks Google's Gemini image model to re-render the cabinets in that finish
//      while keeping everything else in the photo the same
//   3. Emails the result to the customer (with Kevin's contact info) via Resend
//   4. Emails a copy of the lead (photo, selection, customer email) to Westfield
//
// Requires these environment variables to be set in Netlify:
//   GEMINI_API_KEY   - from https://aistudio.google.com/apikey
//   RESEND_API_KEY   - from https://resend.com (requires a verified sending domain)
//   LEAD_EMAIL       - where new leads should land, e.g. kwalter@westfieldcabinetco.com
//   FROM_EMAIL       - the "from" address to send as, e.g. quotes@westfieldcabinetco.com
//                       (must be on a domain verified in Resend)

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const body = await req.json();
    const { imageBase64, imageMime, finishName, finishCode, customerEmail, customerName } = body || {};

    if (!imageBase64 || !finishName || !customerEmail) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const LEAD_EMAIL = process.env.LEAD_EMAIL || "kwalter@westfieldcabinetco.com";
    const FROM_EMAIL = process.env.FROM_EMAIL || "quotes@westfieldcabinetco.com";

    if (!GEMINI_API_KEY || !RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Server is not configured. Missing API keys." }),
        { status: 500 }
      );
    }

    // ---- 1. Generate the AI preview image ----
    const prompt =
      `You are editing a real photo of a kitchen. Replace ONLY the cabinet doors, drawer fronts, ` +
      `and cabinet boxes with a "${finishName}" cabinet finish. Keep the exact room layout, ` +
      `countertops, backsplash, flooring, appliances, wall color, lighting, and camera angle ` +
      `unchanged. The result should look like a photorealistic photo of the same kitchen, just ` +
      `with new cabinets in the "${finishName}" finish.`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: imageMime || "image/jpeg", data: imageBase64 } }
              ]
            }
          ]
        })
      }
    );

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      return new Response(
        JSON.stringify({ error: "AI image generation failed", detail: geminiData }),
        { status: 502 }
      );
    }

    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((p) => p.inlineData || p.inline_data);
    const resultImageB64 =
      (imagePart && (imagePart.inlineData?.data || imagePart.inline_data?.data)) || null;

    if (!resultImageB64) {
      return new Response(
        JSON.stringify({ error: "AI did not return an image", detail: geminiData }),
        { status: 502 }
      );
    }

    // ---- 2. Email the customer their preview ----
    const customerEmailPayload = {
      from: `Westfield Cabinet Co. <${FROM_EMAIL}>`,
      to: [customerEmail],
      subject: `Your Kitchen With ${finishName} Cabinets`,
      html: `
        <p>Hi ${customerName || "there"},</p>
        <p>Here's a preview of your kitchen with <strong>${finishName}</strong> cabinets from Westfield Cabinet Co. (attached).</p>
        <p>This is an AI-generated visualization meant to give you a general sense of the finish — actual results will vary based on lighting, your exact cabinet layout, and materials.</p>
        <p>Want a formal quote, or have questions about this finish? Reach out any time:</p>
        <p>
          Kevin Walter — Westfield Cabinet Co.<br/>
          Phone: (440) 465-7954<br/>
          Email: kwalter@westfieldcabinetco.com<br/>
          <a href="https://westfieldcabinet.com/#contact">westfieldcabinet.com</a>
        </p>
      `,
      attachments: [
        { filename: "your-new-kitchen.png", content: resultImageB64 }
      ]
    };

    const customerSend = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(customerEmailPayload)
    });

    // ---- 3. Email Kevin the lead ----
    const leadEmailPayload = {
      from: `Westfield Site Leads <${FROM_EMAIL}>`,
      to: [LEAD_EMAIL],
      subject: `New Visualizer Lead: ${customerName || customerEmail} — ${finishName}`,
      html: `
        <p>New kitchen visualizer lead:</p>
        <ul>
          <li><strong>Name:</strong> ${customerName || "(not provided)"}</li>
          <li><strong>Email:</strong> ${customerEmail}</li>
          <li><strong>Selected finish:</strong> ${finishName} (${finishCode || ""})</li>
        </ul>
        <p>Original photo and the AI-generated preview (same one sent to the customer) are attached.</p>
      `,
      attachments: [
        { filename: "customer-original-photo.jpg", content: imageBase64 },
        { filename: "ai-preview.png", content: resultImageB64 }
      ]
    };

    const leadSend = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(leadEmailPayload)
    });

    const emailWarnings = [];
    if (!customerSend.ok) emailWarnings.push("customer email failed to send");
    if (!leadSend.ok) emailWarnings.push("lead email failed to send");

    return new Response(
      JSON.stringify({
        success: true,
        previewImage: `data:image/png;base64,${resultImageB64}`,
        warnings: emailWarnings.length ? emailWarnings : undefined
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
