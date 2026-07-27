import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { WebhookDeliveryLogs } from "../WebhookDeliveryLogs";

const { getDeliveryVerification, getLogs } = vi.hoisted(() => {
  const mockLogs = [
    {
      id: "log-verified",
      subscriptionId: "sub-1",
      event: "token.created",
      payload: {},
      statusCode: 200,
      success: true,
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: "log-unverified",
      subscriptionId: "sub-1",
      event: "token.burn.self",
      payload: {},
      statusCode: 200,
      success: true,
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      errorMessage: null,
      createdAt: new Date().toISOString(),
    },
  ];

  const getDeliveryVerification = vi.fn((deliveryId: string) => {
    if (deliveryId === "log-verified") {
      return Promise.resolve({ verified: true, keyId: "ab12cd34", algorithm: "HMAC-SHA256" });
    }
    return Promise.resolve({ verified: false, keyId: "ef56gh78", algorithm: "HMAC-SHA256" });
  });

  const getLogs = vi.fn(() => Promise.resolve(mockLogs));

  return { mockLogs, getDeliveryVerification, getLogs };
});

vi.mock("../../../services/webhookApi", () => ({
  webhookApi: {
    getLogs,
    getDeliveryVerification,
  },
}));

describe("WebhookDeliveryLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a verified badge for a correctly signed delivery", async () => {
    render(<WebhookDeliveryLogs subscriptionId="sub-1" />);

    await waitFor(() => expect(screen.getAllByText("Verified").length).toBeGreaterThan(0));
    expect(screen.getByText(/ab12cd34/)).toBeInTheDocument();
  });

  it("renders an unverified badge when the signature does not match", async () => {
    render(<WebhookDeliveryLogs subscriptionId="sub-1" />);

    await waitFor(() => expect(screen.getAllByText("Unverified").length).toBeGreaterThan(0));
    expect(screen.getByText(/ef56gh78/)).toBeInTheDocument();
  });

  it("links to the signature verification documentation", async () => {
    render(<WebhookDeliveryLogs subscriptionId="sub-1" />);

    await waitFor(() => expect(screen.getAllByText("Verified").length).toBeGreaterThan(0));
    const docLinks = screen.getAllByTitle("How to verify this signature independently");
    expect(docLinks.length).toBeGreaterThan(0);
    expect(docLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining("WEBHOOK_SIGNATURE_VERIFICATION.md")
    );
  });
});
