"use client";

import { useEffect } from "react";
import type { AppLanguage } from "@/lib/domain/types";
import { translateText } from "@/lib/i18n";

const translatedAttributes = ["aria-label", "placeholder", "title"] as const;
const textSources = new WeakMap<Text, string>();
const attributeSources = new WeakMap<Element, Map<string, string>>();

function translateTree(root: Element, language: AppLanguage) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = root;

  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text, language);
    if (node.nodeType === Node.ELEMENT_NODE) translateElement(node as Element, language);
    node = walker.nextNode();
  }
}

function translateTextNode(node: Text, language: AppLanguage) {
  const current = node.nodeValue ?? "";
  let source = textSources.get(node);
  if (source === undefined || (language === "en" && current !== source && current !== translateText(source, "en"))) {
    source = current;
    textSources.set(node, source);
  }
  const translated = translateText(source, language);
  if (current !== translated) node.nodeValue = translated;
}

function translateElement(element: Element, language: AppLanguage) {
  let sources = attributeSources.get(element);
  if (!sources) {
    sources = new Map();
    attributeSources.set(element, sources);
  }

  for (const attribute of translatedAttributes) {
    const current = element.getAttribute(attribute);
    if (current === null) continue;
    let source = sources.get(attribute);
    if (source === undefined || (language === "en" && current !== source && current !== translateText(source, "en"))) {
      source = current;
      sources.set(attribute, source);
    }
    const translated = translateText(source, language);
    if (current !== translated) element.setAttribute(attribute, translated);
  }
}

export function useDocumentTranslation(language: AppLanguage) {
  useEffect(() => {
    const root = document.querySelector(".app-shell");
    if (!root) return;

    let applying = false;
    const observer = new MutationObserver(() => applyTranslation());
    const observe = () => observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...translatedAttributes],
    });
    const applyTranslation = () => {
      if (applying) return;
      applying = true;
      observer.disconnect();
      translateTree(root, language);
      observe();
      applying = false;
    };

    applyTranslation();
    return () => observer.disconnect();
  }, [language]);
}
