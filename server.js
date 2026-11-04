//server.js
var express = require("express");
var DB = require('nedb-promises'); 
var bodyParser = require('body-parser');
server = express();

server.use(express.static(__dirname+"/Bootstrap5"));//web root
server.use(bodyParser.urlencoded({ extended: true }));
server.use(bodyParser.json());

var Contact = new DB({ filename: 'contact.db', autoload: true });

server.get("/contact",function(req,res){ //web root
 	res.send("Hello, World!"); //回傳固定內容
	Contact.insert(req.query);
 });

server.post("/contact", async function(req,res){
	const contact = await Contact.insert(req.body);
	res.status(201).json(contact)
	;
});

server.get("/*splat", function(req,res){ //other pages, express 4 use * 
 	res.send("Page not found", 404);
 });
 server.listen(80);
console.log("Express run on port: 80");
//run: node server.js
//browser: http://localhost:8080
