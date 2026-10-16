import * as Gtk from "@gtkx/gi/gtk";
import { rootElement } from "@gtkx/react";
import { render, screen } from "@gtkx/testing";
import { describe, expect, it } from "vitest";
import App from "../src/app.js";
import { isValidServer, isValidUser } from "../src/vpn.js";

describe("App", () => {
    it("renders the connect or disconnect button", async () => {
        await render(<App />, { container: rootElement });
        const button = await screen.findByRole(Gtk.AccessibleRole.BUTTON, { name: /^(Connect|Disconnect)$/ });
        expect(button).toBeDefined();
    });
});

describe("input validation", () => {
    it("accepts IP addresses and hostnames", () => {
        expect(isValidServer("160.30.9.221")).toBe(true);
        expect(isValidServer("vpn.example.gov.kh")).toBe(true);
    });

    it("rejects values that could be read as options or shell syntax", () => {
        expect(isValidServer("--script=/tmp/x")).toBe(false);
        expect(isValidServer("1.2.3.4 --hip")).toBe(false);
        expect(isValidServer("")).toBe(false);
        expect(isValidUser("-x")).toBe(false);
        expect(isValidUser("")).toBe(true);
        expect(isValidUser("user@tsc.gov.kh")).toBe(true);
    });
});
