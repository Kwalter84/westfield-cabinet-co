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

    // ---- 1. Fetch a real photo of the chosen finish to use as a style reference ----
    // This is the key to getting an actual new-cabinet look (door profile, wood grain,
    // hardware) instead of Gemini just recoloring the existing doors: we show it a real
    // Westfield sample photo of that exact finish alongside the customer's kitchen.
    const FINISH_FILENAMES = {
      ASP: "finish-aspen-white.jpg",
      BC: "finish-bristol-chocolate.jpg",
      HS: "finish-hickory-shaker.jpg",
      MO: "finish-glazed-mocha.jpg",
      NG: "finish-winchester-grey.jpg",
      PS: "finish-platinum-shaker.jpg",
      WPG: "finish-west-point-grey.jpg",
      WS: "finish-white-shaker.jpg",
      MBS: "finish-midnight-black-shaker.jpg",
      FS: "finish-fresh-sage.jpg",
      CS: "finish-carmel-shaker.jpg"
    };
    const SITE_URL = process.env.URL || "https://westfieldcabinet.com";
    const referenceFilename = FINISH_FILENAMES[finishCode];
    let referenceImageB64 = null;
    if (referenceFilename) {
      try {
        const refRes = await fetch(`${SITE_URL}/${referenceFilename}`);
        if (refRes.ok) {
          const refBuffer = await refRes.arrayBuffer();
          referenceImageB64 = Buffer.from(refBuffer).toString("base64");
        }
      } catch {
        // If the reference photo can't be fetched, fall back to text-only prompting below.
      }
    }

    // ---- 2. Generate the AI preview image ----
    const promptParts = [];
    if (referenceImageB64) {
      promptParts.push({
        text:
          `Image 1 is a real photo of a customer's kitchen. Image 2 is an official Westfield ` +
          `Cabinet Co. sample photo of their "${finishName}" cabinet finish, showing the correct ` +
          `door style, panel profile, wood grain/texture, sheen, and hardware for that finish.\n\n` +
          `Edit Image 1 so that every cabinet door, drawer front, and cabinet box is replaced with ` +
          `new cabinets that match the door style, material, texture, color, and hardware shown in ` +
          `Image 2 — not just a color tint, but the actual door profile and finish shown in Image 2. ` +
          `This includes ALL cabinetry visible in Image 1: perimeter/wall cabinets, base cabinets, ` +
          `and — importantly — any kitchen island, peninsula, or freestanding cabinetry as well. Do ` +
          `not skip or leave unchanged any cabinet doors or drawer fronts anywhere in the photo, ` +
          `including islands.\n\n` +
          `IMPORTANT — do a complete replacement, not a recolor: for EVERY individual door and ` +
          `drawer front in Image 1, fully remove the original panel details (raised panel lines, ` +
          `moulding, flat panel grooves, existing wood grain direction, existing knots) and rebuild ` +
          `each one from scratch to exactly match Image 2's door style, panel lines, and grain — ` +
          `on every single door and drawer, with zero exceptions. Check corner cabinets, small ` +
          `doors, cabinets above the refrigerator, cabinets above/around the range hood, and any ` +
          `doors partially visible at the edge of the frame — none of these should retain any trace ` +
          `of the original door pattern underneath the new color. If you are not fully confident a ` +
          `door has been completely rebuilt to match Image 2, redo it rather than leaving the ` +
          `original panel lines visible.\n\n` +
          `Also update the cabinet door/drawer hardware (knobs and pulls) to a style and finish ` +
          `(e.g. matte black, brushed nickel, oil-rubbed bronze, brass) that realistically ` +
          `complements the new "${finishName}" cabinets. Also update the visible countertop surface ` +
          `to a complementary modern countertop material and color that pairs naturally with the new ` +
          `cabinets, so the whole kitchen looks cohesive and finished.\n\n` +
          `Keep everything else in Image 1 exactly the same: room layout, backsplash, flooring, ` +
          `appliances, wall color, lighting, and camera angle. The output should be a single ` +
          `photorealistic photo of the customer's kitchen with genuinely new "${finishName}" ` +
          `cabinets, new matching hardware, and a new complementary countertop, installed ` +
          `throughout, including the island if one is present.`
      });
      promptParts.push({ inline_data: { mime_type: imageMime || "image/jpeg", data: imageBase64 } });
      promptParts.push({ inline_data: { mime_type: "image/jpeg", data: referenceImageB64 } });
    } else {
      promptParts.push({
        text:
          `Edit this real kitchen photo so every cabinet door, drawer front, and cabinet box is ` +
          `replaced with new "${finishName}" cabinets — a real door style and material change, not ` +
          `just a color tint. This includes ALL cabinetry in the photo: perimeter/wall cabinets, ` +
          `base cabinets, and any kitchen island, peninsula, or freestanding cabinetry too — do not ` +
          `skip the island. For EVERY individual door and drawer front, fully remove the original ` +
          `panel details (raised panel lines, moulding, existing wood grain, knots) and rebuild each ` +
          `one from scratch in the new finish — including corner cabinets, small doors, cabinets ` +
          `above the refrigerator or range hood, and any doors at the edge of the frame. None should ` +
          `retain any trace of the original door pattern underneath the new color. Also update the ` +
          `door/drawer hardware (knobs and pulls) to a style and finish that realistically ` +
          `finish that realistically complements the new cabinets, and update the visible ` +
          `countertop to a complementary modern countertop material and color so the kitchen looks ` +
          `cohesive and finished. Keep the room layout, backsplash, flooring, appliances, wall ` +
          `color, lighting, and camera angle exactly the same. Photorealistic result.`
      });
      promptParts.push({ inline_data: { mime_type: imageMime || "image/jpeg", data: imageBase64 } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: promptParts }]
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
        <p>This is an AI-generated visualization meant to give you a general sense of the finish — actual results will vary based on lighting, your exact cabinet layout, and materials. Note that the countertop and hardware shown are for visual purposes only, to give a more complete picture of the finished look — countertops are not a product or service offered by Westfield Cabinet Co., and hardware shown is a suggestion, not a specific product.</p>
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
