//! The slice's source scanner (UNB-208): where a statement, a function or a brace pair ends in script text, whatever
//! strings and comments sit in it.
use super::*;

/// A statement runs to its `;` at the same depth, or to the brace that closes it: a `}` or `;` inside a string, a
/// line comment or a block comment is not its end.
#[test]
fn a_statement_ends_where_the_code_ends_it_not_where_a_string_or_a_comment_says() {
    let src = "function f(){ return '};' }";
    assert_eq!(statement_span(src, 0), Some((0, src.len())), "a quoted brace and semicolon");
    let src = "x = { a: 1 /* } */, b: 2 // }\n };";
    assert_eq!(statement_span(src, 0), Some((0, src.len())), "braces in comments");
    let src = "x = \"a\\\"};\" + 1;";
    assert_eq!(statement_span(src, 0), Some((0, src.len())), "an escaped quote does not end the string");
    let src = "x = `a};${b}` + 1; y = 2;";
    assert_eq!(&src[..statement_span(src, 0).unwrap().1], "x = `a};${b}` + 1;", "a template string");
    let src = "a: 1 }, b: 2";
    assert_eq!(statement_span(src, 0), Some((0, 6)), "a value ends at the brace of the object it is in");
    assert_eq!(statement_span("var a = 1", 0), None, "nothing closes it");
    let src = "// } ;";
    assert_eq!(statement_span(src, 0), None, "a comment to the end of the text closes nothing");
    assert_eq!(statement_span("/* ; } */", 0), None, "a block comment never closed by the text's end closes nothing");
}

/// The function around a spot is the nearest `function` whose braces enclose it: not a word that ends in the name, not
/// one that has closed, not one that opens after the spot.
#[test]
fn the_function_around_a_spot_is_the_nearest_whose_braces_hold_it() {
    let src = "var a = function outer(){ var b = function(){ X; }; Y; }";
    let x = src.find("X;").unwrap();
    let y = src.find("Y;").unwrap();
    let inner = enclosing_function(src, x).unwrap();
    assert_eq!(&src[inner.0..inner.1], "function(){ X; }");
    let outer = enclosing_function(src, y).unwrap();
    assert_eq!(&src[outer.0..outer.1], "function outer(){ var b = function(){ X; }; Y; }");
    assert_eq!(enclosing_function("var myfunction(){ Z }", 18), None, "a word that ends in `function` is not the keyword");
    let src = "function f(){ } trailing";
    assert_eq!(enclosing_function(src, src.find("trailing").unwrap()), None, "a function that closed before the spot");
    let src = "var here = 1; function later(){ }";
    assert_eq!(enclosing_function(src, 5), None, "a function that opens after the spot");
    let src = "function broken( { X";
    assert_eq!(enclosing_function(src, src.find('X').unwrap()), None, "braces that never close hold nothing");
}

/// The brace pair around a spot is the nearest whose match closes after it, with quoted and commented braces ignored.
#[test]
fn the_braces_around_a_spot_are_the_nearest_pair_that_closes_after_it() {
    let src = "a { b { X } c }";
    let x = src.find('X').unwrap();
    assert_eq!(enclosing_brace(src, x), Some((6, 11)));
    assert_eq!(enclosing_brace(src, src.find('c').unwrap()), Some((2, src.len())), "the outer pair when the inner one closed");
    let src = "{ s = '}' + \"}\" + `}`; /* } */ // }\n X }";
    assert_eq!(enclosing_brace(src, src.find('X').unwrap()), Some((0, src.len())), "braces in strings and comments are not braces");
    assert_eq!(enclosing_brace("no braces at all", 5), None);
    assert_eq!(matching_brace("{ never closed", 0), None);
    assert_eq!(matching_brace("{ 'a\\'}' }", 0), Some(9), "an escaped quote keeps the string open");
}

/// A fragment of a bundle is carried only if it reads as a statement: not an object property, not a bare expression.
#[test]
fn a_fragment_is_a_statement_when_it_opens_like_one_or_assigns() {
    for yes in ["function f(){}", "async function f(){}", "var a = 1", "  let a = 1", "const a = 1", "class A {}", "!function(){}()", "(function(){})()", "if (a) b()", "return a", "window.x = 1", "a.b.c = 5", "$x_ = 1"] {
        assert!(plausible(yes), "{yes}");
    }
    for no in ["cSign:l", "a", "k: v = 1", "= 1", "a b = 1", "x[0] = 1"] {
        assert!(!plausible(no), "{no}");
    }
}

/// Where no function holds a spot, the unit around it is its statement between `;` and line ends, and a spot past the
/// end of the text is the end.
#[test]
fn a_spot_in_no_function_is_carried_as_its_statement_or_its_line() {
    let src = "var a = 1;\nvar sig = sign(x);\nvar b = 2;";
    let at = src.find("sign").unwrap();
    let (from, to, text) = around(src, at, false).unwrap();
    assert_eq!(text, src[from..to]);
    assert_eq!(text, "var sig = sign(x);", "the statement from the line start through its `;`");
    let (_, to, text) = around("abc", 99, false).unwrap();
    assert_eq!((to, text.as_str()), (3, "abc"), "past the end is the end");
    // A definition is carried whole, to its closing brace, where the name is bound by a declaration.
    let src = "var pad = 1; function enc(a){ return a + '}'; } var z = 2;";
    let at = src.find("function enc").unwrap();
    let (from, to, text) = around(src, at, true).unwrap();
    assert_eq!(&src[from..to], text);
    assert!(text.starts_with("function enc(a){") && text.contains("'}'"), "{text}");
}

/// A definition is found where the name is bound, by the likeliest spelling first: a declaration, a property written as
/// a function, a quoted key, an assignment on the page's global; failing those, the name read without its underscores
/// and case.
#[test]
fn a_name_is_found_where_the_code_binds_it() {
    assert_eq!(defines("x; function enc(a){}", "enc"), Some(3), "a function declaration");
    assert_eq!(defines("x; var enc = 1", "enc"), Some(3), "a variable");
    assert_eq!(defines("({ enc: function(a){} })", "enc"), Some(3), "a property that is a function");
    assert_eq!(defines("y = {'enc': 2}", "enc"), Some(5), "a quoted key");
    assert_eq!(defines("a.enc = 5", "enc"), Some(1), "a property assigned");
    assert_eq!(defines("x; window.enc = 5", "enc"), Some(3), "an assignment on the global");
    assert_eq!(defines("x; self.enc=5", "enc"), Some(3));
    assert_eq!(defines("enc = 5", "enc"), Some(0), "a bare assignment");
    assert_eq!(defines("call(cSignValue)", "c_sign_value"), Some(5), "spelled without its underscores and case");
    assert_eq!(defines("nothing here", "enc"), None);
    assert_eq!(defines("function ab(){}", "ab"), Some(0), "a short name is found by its declaration");
    assert_eq!(defines("xx", "x_"), None, "a folded name too short to look for");
    // The earliest of one kind wins over a later one of the same kind.
    assert_eq!(defines("function enc(){} var enc = 1", "enc"), Some(0));
}

/// The names a piece of code uses are its words of three letters or more that are not the language's or the page's
/// common ones, each once.
#[test]
fn the_names_a_piece_of_code_uses_are_its_own_words_once_each() {
    let mut out = Vec::new();
    names("function sign(req) { return encode(req.query) + encode(sk) + window.cSign; }", &mut out);
    let found: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(found, ["sign", "req", "query", "cSign"], "short words, the language's and the common ones left out, once each");
    assert!(out.iter().all(|(_, depth)| *depth == 0));
}

/// A producer whose script the parser can't read is sliced by the scanner: the function around the write site first, then
/// what it calls, each from the script that defines it.
#[test]
fn a_script_the_parser_cannot_read_is_sliced_by_the_scanner() {
    let script = "function enc(t){ return 'e:' + t; }\nfunction sign(req){ req.headers['x-sig'] = enc(req.q); }\n ))) not javascript";
    let at = script.find("x-sig").unwrap();
    let scripts = [("https://shop.example/app.js", script)];
    let producer = crate::signing::Producer { script: "https://shop.example/app.js".into(), at, frame: false };
    let slice = of(&scripts, &producer);
    assert_eq!(slice.pieces.len(), 2, "{:?}", slice.pieces);
    assert_eq!(slice.pieces[0].name, "write site");
    assert!(slice.pieces[0].src.starts_with("function sign(req)") && slice.pieces[0].src.contains("x-sig"), "{}", slice.pieces[0].src);
    assert!(slice.pieces[1].src.starts_with("function enc(t)"), "{}", slice.pieces[1].src);
    assert!(slice.text().contains("(write site)"));
    // Another script that does not hold the producer's, or a place outside any script, yields nothing.
    assert!(of(&[("https://shop.example/other.js", script)], &producer).pieces.is_empty());
    // A program is lifted from it: the definitions first, then the write site as the producer.
    let program = assemble(&scripts, &producer, "x-sig").expect("a program");
    assert!(program.find("function enc").unwrap() < program.find("__unbrowse_producer").unwrap(), "{program}");
    assert!(assemble(&scripts, &producer, "x-other").is_none(), "the write site never mentions that header");
    assert!(assemble(&[], &producer, "x-sig").is_none());
}
