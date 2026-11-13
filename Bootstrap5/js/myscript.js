const app = Vue.createApp({
    data() {
        return {
            Services: [
                { "icon": "fa-shopping-cart", "title": "E-Commerce", "desc": "Lorem ipsum dolor sit, amet consectetur adipisicing elit. Pariatur porro laborum fuga repellat." },
                { "icon": "fa-laptop", "title": "Responsive Design", "desc": "Lorem ipsum dolor sit" },
                { "icon": "fa-lock", "title": "Web Security", "desc": "Lorem ipsum dolor sit" }
            ]
        }
    },
    methods: {

    },
    updated:{

    }

})
app.mount('#services')
//Get data from Server
app.Services=[]
                