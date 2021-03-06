module.exports = function( grunt ) {
"use strict";

function htmlEscape( text ) {
	return text
		// supports keeping markup in source file, but drop from inline sample
		.replace( /<!-- @placeholder-start\((.+)\) -->[\s\S]+@placeholder-end -->/g, function( match, input ) {
			return "<!-- " + input + " -->";
		})
		.replace( /&/g, "&amp;" )
		.replace( /</g, "&lt;" )
		.replace( />/g, "&gt;" )
		.replace( /"/g, "&quot;" )
		.replace( /'/g, "&#039;" );
}

var cheerio = require( "cheerio" ),
	hljs = require( "highlight.js" ),
	he = require( "he" ),
	yaml = require( "js-yaml" );

// Add a wrapper around wordpress-parse-post that supports YAML
grunt.registerHelper( "wordpress-parse-post-flex", function( path ) {
	var index,
		post = {},
		content = grunt.file.read( path );

	// Check for YAML metadata
	if ( content.substring( 0, 4 ) === "---\n" ) {
		try {
			index = content.indexOf( "\n---\n" );
			post = yaml.load( content.substr( 4, index - 4 ) );
			content = content.substr( index + 5 );
		} catch( error ) {
			grunt.log.error( "Invalid YAML metadata for " + path );
			return null;
		}

		post.content = content;
		return post;
	}

	// Fall back to standard JSON parsing
	return grunt.helper( "wordpress-parse-post", path );
});

grunt.registerMultiTask( "build-pages", "Process html and markdown files as pages, include @partials and syntax higlight code snippets", function() {
	var task = this,
		taskDone = task.async(),
		files = this.data,
		targetDir = grunt.config( "wordpress.dir" ) + "/posts/page/";

	grunt.file.mkdir( targetDir );

	grunt.utils.async.forEachSeries( files, function( fileName, fileDone ) {
		var content,
			post = grunt.helper( "wordpress-parse-post-flex", fileName ),
			fileType = /\.(\w+)$/.exec( fileName )[ 1 ],
			targetFileName = targetDir +
				fileName.replace( /^.+?\/(.+)\.\w+$/, "$1" ) + ".html";

		grunt.verbose.write( "Processing " + fileName + "..." );

		function processPost() {
			content = post.content;
			delete post.content;

			// Convert markdown to HTML
			if ( fileType === "md" ) {
				content = grunt.helper( "parse-markdown", content, {
					generateLinks: post.toc || !post.noHeadingLinks,
					generateToc: post.toc
				});
				delete post.noHeadingLinks;
				delete post.toc;
			}

			// Replace partials
			content = content.replace( /@partial\((.+)\)/g, function( match, input ) {
				return htmlEscape( grunt.file.read( input ) );
			});

			// Syntax highlight code blocks
			if ( !grunt.option( "nohighlight" ) ) {
				content = grunt.helper( "syntax-highlight", { content: content } );
			}

			post.customFields = post.customFields || [];
			post.customFields.push({
				key: "source_path",
				value: fileName
			});

			// Write file
			grunt.file.write( targetFileName,
				"<script>" + JSON.stringify( post ) + "</script>\n" + content );

			fileDone();
		}

		// Invoke the pre-processor for custom functionality
		grunt.helper( "build-pages-preprocess", post, fileName, processPost );
	}, function() {
		if ( task.errorCount ) {
			grunt.warn( "Task \"" + task.name + "\" failed." );
			taskDone();
			return;
		}
		grunt.log.writeln( "Built " + files.length + " pages." );
		taskDone();
	});
});

// Default pre-processor is a no-op
grunt.registerHelper( "build-pages-preprocess", function( post, fileName, done ) {
	done();
});

grunt.registerMultiTask( "build-resources", "Copy resources", function() {
	var task = this,
		taskDone = task.async(),
		files = this.data,
		targetDir = grunt.config( "wordpress.dir" ) + "/resources/";

	grunt.file.mkdir( targetDir );

	grunt.utils.async.forEachSeries( files, function( fileName, fileDone )  {
		grunt.file.copy( fileName, targetDir + fileName.replace( /^.+?\//, "" ) );
		fileDone();
	}, function() {
		if ( task.errorCount ) {
			grunt.warn( "Task \"" + task.name + "\" failed." );
			taskDone();
			return;
		}
		grunt.log.writeln( "Built " + files.length + " resources." );
		taskDone();
	});
});

grunt.registerHelper( "syntax-highlight", (function() {
	var lineNumberTemplate = grunt.file.read(
		grunt.task.getFile( "jquery-build/lineNumberTemplate.jst" ) );

	return function( options ) {

		// receives the innerHTML of a <code> element and if the first character
		// is an encoded left angle bracket, we'll assume the language is html
		function crudeHtmlCheck ( input ) {
			var first = input.trim().charAt( 0 );
			return ( first === "&lt;" || first === "<" ) ? "xml" : "";
		}

		// when parsing the class attribute, make sure a class matches an actually
		// highlightable language, instead of being presentational (e.g. 'example')
		function getLanguageFromClass( str ) {
			str = str || "";
			var classes = str.split( " " ),
				i = 0,
				length = classes.length;
			for ( ; i < length; i++ ) {
				if ( hljs.LANGUAGES[ classes[ i ].replace( /^lang-/, "" ) ] ) {
					return classes[i].replace( /^lang-/, "" );
				}
			}
			return "";
		}

		function outdent( string ) {
			var rOutdent,
				adjustedLines = [],
				minTabs = Infinity,
				rLeadingTabs = /^\t+/;

			string.split( "\n" ).forEach(function( line, i, arr ) {
				// Don't include first or last line if it's nothing but whitespace
				if ( (i === 0 || i === arr.length - 1) && !line.trim().length ) {
					return;
				}

				// For empty lines inside the snippet, push a space so the line renders properly
				if ( !line.trim().length ) {
					adjustedLines.push(" ");
					return;
				}

				// Count how many leading tabs there are and update the global minimum
				var match = line.match( rLeadingTabs ),
					tabs = match ? match[0].length : 0;
				minTabs = Math.min( minTabs, tabs );

				adjustedLines.push( line );
			});

			if ( minTabs !== Infinity ) {
				// Outdent the lines as much as possible
				rOutdent = new RegExp( "^\t{" + minTabs + "}" );
				adjustedLines = adjustedLines.map(function( line ) {
					return line.replace( rOutdent, "" );
				});
			}

			return adjustedLines.join( "\n" );
		}

		var html = options.file ? grunt.file.read( options.file ) : options.content,
			$ = cheerio.load( html );

		$( "pre > code" ).each(function() {
			var $t = $( this ),
				code = he.decode( outdent( $t.html() ) ),
				lang = $t.attr( "data-lang" ) ||
					getLanguageFromClass( $t.attr( "class" ) ) ||
					crudeHtmlCheck( code ) ||
					"javascript",
				linenumAttr = $t.attr( "data-linenum" ),
				linenum = (linenumAttr === "true" ? 1 : parseInt( linenumAttr, 10 ) ) || 1,
				gutter = linenumAttr === undefined ? false : true,
				highlighted = hljs.highlight( lang, code ),
				fixed = hljs.fixMarkup( highlighted.value, "  " );

			// Handle multi-line comments (#32)
			fixed = fixed.replace( /<span class="comment">\/\*([^<]+)\*\/<\/span>/g, function( full, comment ) {
				return "<span class=\"comment\">/*" +
					comment.split( "\n" ).join( "</span>\n<span class=\"comment\">" ) +
					"*/</span>";
			});
			$t.parent().replaceWith( grunt.template.process( lineNumberTemplate, {
				lines: fixed.split("\n"),
				startAt: linenum,
				gutter: gutter,
				lang: lang
			}));
		});

		return $.html();
	};
})() );

grunt.registerHelper( "parse-markdown", function( src, options ) {
	var toc = "",
		marked = require( "marked" ),
		tokens = marked.lexer( src ),
		links = tokens.links;

	if ( !options.generateLinks ) {
		return marked.parser( tokens );
	}

	tokens.forEach(function( item ) {
		if ( item.type !== "heading" ) {
			return;
		}

		// Store original text and create an id for linking
		var parsedText = marked( item.text );
		parsedText = parsedText.substring( 3, parsedText.length - 5 );
		item.tocText = parsedText.replace( /<[^>]+>/g, "" );
		item.tocId = item.tocText
			.replace( /\W+/g, "-" )
			.replace( /^-+|-+$/, "" )
			.toLowerCase();

		// Convert to HTML
		item.type = "html";
		item.pre = false;

		// Insert the link
		item.text = "<h" + item.depth + " class='toc-linked'>" +
			"<a href='#" + item.tocId + "' id='" + item.tocId + "' class='icon-link toc-link'>" +
				"<span class='visuallyhidden'>link</span>" +
			"</a> " + parsedText + "</h" + item.depth + ">";

		if ( options.generateToc ) {
			toc += new Array( (item.depth - 1) * 2 + 1 ).join( " " ) + "* " +
				"[" + item.tocText + "](#" + item.tocId + ")\n";
		}
	});

	if ( options.generateToc ) {
		tokens = marked.lexer( toc ).concat( tokens );
		// The TOC never generates links, so we can just copy the links directly
		// from the original tokens.
		tokens.links = links;
	}

	return marked.parser( tokens );
});

};
