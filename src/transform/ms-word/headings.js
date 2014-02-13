/**
 * transform/ms-word/headings.js is part of Aloha Editor project http://aloha-editor.org
 *
 * Aloha Editor is a WYSIWYG HTML5 inline editing library and editor.
 * Copyright (c) 2010-2014 Gentics Software GmbH, Vienna, Austria.
 * Contributors http://aloha-editor.org/contribution.php
 */
define([
	'dom',
	'transform/ms-word/utils'
], function (
	Dom,
	Utils
) {
	'use strict';

	/**
	 * Cleans a list of headings.
	 *
	 * @param {Array.<Element>} headings
	 */
	function cleanHeadings(headings) {
		headings.forEach(Utils.cleanElement);
	}

	/**
	 * Replaces the list of headings by elements of the given `nodeName`.
	 *
	 * @param {Document} doc
	 * @param {Array.<Element>} headings
	 * @param {string} nodeName
	 */
	function transformHeadings(doc, headings, nodeName) {
		cleanHeadings(headings);
		headings.forEach(function (heading) {
			Dom.replaceShallow(heading, doc.createElement(nodeName));
		});
	}

	/**
	 * Replaces titles and subtitles with h1 and h2 respectively, in the given
	 * element.
	 *
	 * @param {Element} element
	 */
	function transform(element) {
		var titles = element.querySelectorAll('.MsoTitle');
		var subtitles = element.querySelectorAll('.MsoSubtitle');
		var headings = element.querySelectorAll('h1,h2,h3,h4,h5,h6');
		var doc = element.ownerDocument;
		transformHeadings(doc, titles, 'h1');
		transformHeadings(doc, subtitles, 'h2');
		cleanHeadings(headings);
	}

	return {
		transform: transform
	};
});